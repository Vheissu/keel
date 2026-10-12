package main

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

func dockerCommand(ctx context.Context, input io.Reader, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, "docker", args...)
	command.Stdin = input
	// Bound output and never forward image output or command errors into control-plane logs.
	var output cappedBuffer
	command.Stdout = &output
	command.Stderr = &output
	err := command.Run()
	if err != nil {
		return nil, errors.New("docker operation failed")
	}

	return output.Bytes(), nil
}

type cappedBuffer struct{ bytes.Buffer }

func (b *cappedBuffer) Write(p []byte) (int, error) {
	length := len(p)
	remaining := 65536 - b.Len()
	if remaining > 0 {
		_, _ = b.Buffer.Write(p[:min(length, remaining)])
	}

	return length, nil
}

func containerName(j Job) string { return "keel-target-" + j.TargetID }

func (a *Agent) cleanup(ctx context.Context, j Job) error {
	// Listing succeeds even when absent; a daemon error must never look like cleanup success.
	ids, err := a.docker(ctx, nil, "container", "ls", "--all", "--filter", "name=^/"+containerName(j)+"$", "--format", "{{.ID}}")
	if err != nil {
		return err
	}

	if strings.TrimSpace(string(ids)) == "" {
		return nil
	}

	label, err := a.docker(ctx, nil, "container", "inspect", "--format", `{{index .Config.Labels "keel.target"}}`, containerName(j))
	if err != nil || strings.TrimSpace(string(label)) != j.TargetID {
		return errors.New("container ownership mismatch")
	}

	fence, err := a.docker(ctx, nil, "container", "inspect", "--format", `{{index .Config.Labels "keel.fence"}}`, containerName(j))
	currentFence, parseErr := strconv.Atoi(strings.TrimSpace(string(fence)))
	if err != nil || parseErr != nil || currentFence > j.Fence {
		return errors.New("target fence is newer than this lease")
	}
	_, err = a.docker(ctx, nil, "container", "rm", "--force", "--volumes", containerName(j))
	return err
}

// Read metadata without extracting any paths from the publisher's archive.
func verifyImageArchive(data []byte, imageID string) error {
	reader := tar.NewReader(bytes.NewReader(data))
	files := map[string]string{}
	var manifest []byte
	for {
		header, err := reader.Next()
		if err == io.EOF {
			break
		}

		if err != nil {
			return errors.New("invalid image archive")
		}

		if header.Typeflag != tar.TypeReg {
			continue
		}

		if _, duplicate := files[header.Name]; duplicate {
			return errors.New("duplicate image archive entry")
		}

		content, err := io.ReadAll(io.LimitReader(reader, 25*1024*1024+1))
		if err != nil || len(content) > 25*1024*1024 {
			return errors.New("invalid image archive entry")
		}

		digest := sha256.Sum256(content)
		files[header.Name] = "sha256:" + hex.EncodeToString(digest[:])
		if header.Name == "manifest.json" {
			manifest = content
		}
	}

	var images []struct {
		Config string `json:"Config"`
	}

	if json.Unmarshal(manifest, &images) != nil || len(images) != 1 || files[images[0].Config] != imageID {
		return errors.New("archive must contain one image matching the release image ID")
	}

	return nil
}

func (a *Agent) deploy(ctx context.Context, j Job, t Target) string {
	a.progress(ctx, j, "downloading")
	artifact, err := a.request(ctx, "artifact", j.Lease)
	if err != nil {
		return "ARTIFACT_INVALID"
	}

	digest := sha256.Sum256(artifact)
	if int64(len(artifact)) != j.Size || hex.EncodeToString(digest[:]) != j.Digest {
		return "ARTIFACT_INVALID"
	}

	artifact, err = imageArchive(artifact, j.ArchivePath)
	if err != nil || verifyImageArchive(artifact, j.ImageID) != nil {
		return "ARTIFACT_INVALID"
	}

	a.progress(ctx, j, "loading_image")
	if _, err = a.docker(ctx, bytes.NewReader(artifact), "image", "load", "--quiet"); err != nil {
		return "DOCKER_FAILED"
	}

	image, err := a.docker(ctx, nil, "image", "inspect", "--format", "{{.Id}}", j.ImageID)
	if err != nil || strings.TrimSpace(string(image)) != j.ImageID {
		return "ARTIFACT_INVALID"
	}

	// Recheck immediately before replacing the target. Heartbeats also cancel in-flight work.
	action, err := a.heartbeat(ctx, j)
	if err != nil || action != "continue" {
		return "CANCELLED"
	}

	a.progress(ctx, j, "replacing_container")
	if a.cleanup(ctx, j) != nil {
		return "DOCKER_FAILED"
	}

	args := []string{
		"container", "create",
		"--name", containerName(j),
		"--label", "keel.target=" + j.TargetID,
		"--label", "keel.attempt=" + j.AttemptID,
		"--label", "keel.fence=" + strconv.Itoa(j.Fence),
		"--read-only",
		"--user", "65532:65532",
		"--cap-drop", "ALL",
		"--security-opt", "no-new-privileges",
		"--memory", "256m",
		"--cpus", "1",
		"--pids-limit", "64",
		"--restart", "no",
		"--publish", fmt.Sprintf("127.0.0.1:%d:%d", t.HostPort, t.ContainerPort),
		j.ImageID,
	}

	if _, err = a.docker(ctx, nil, args...); err != nil {
		return "DOCKER_FAILED"
	}

	if _, err = a.docker(ctx, nil, "container", "start", containerName(j)); err != nil {
		return "DOCKER_FAILED"
	}

	a.progress(ctx, j, "verifying_http")
	client := &http.Client{
		Timeout:   2 * time.Second,
		Transport: &http.Transport{Proxy: nil},
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}

	defer client.CloseIdleConnections()
	for tries := 0; tries < 30; tries++ {
		if ctx.Err() != nil {
			return "CANCELLED"
		}

		req, err := http.NewRequestWithContext(ctx, http.MethodGet, fmt.Sprintf("http://127.0.0.1:%d%s", t.HostPort, j.HealthPath), nil)
		if err != nil {
			return "HEALTH_FAILED"
		}

		response, err := client.Do(req)
		if err == nil {
			_ = response.Body.Close()
			if response.StatusCode == 200 {
				state, inspectErr := a.docker(ctx, nil, "container", "inspect", "--format", `{{.State.Running}} {{index .Config.Labels "keel.attempt"}} {{index .Config.Labels "keel.fence"}} {{.Image}}`, containerName(j))
				expected := fmt.Sprintf("true %s %d %s", j.AttemptID, j.Fence, j.ImageID)
				if inspectErr == nil && strings.TrimSpace(string(state)) == expected {
					return "HTTP_VERIFIED"
				}
			}
		}

		select {
		case <-ctx.Done():
			return "CANCELLED"
		case <-time.After(time.Second):
		}
	}

	return "HEALTH_FAILED"
}
