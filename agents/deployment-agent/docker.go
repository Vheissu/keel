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
	"log"
	"net/http"
	"os"
	"os/exec"
	"path"
	"slices"
	"strconv"
	"strings"
	"time"
)

func dockerCommand(ctx context.Context, input io.Reader, args ...string) ([]byte, error) {
	return dockerCommandWithLock(ctx, input, nil, args...)
}

func dockerCommandWithLock(ctx context.Context, input io.Reader, lock *os.File, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, "docker", args...)
	command.Stdin = input
	if lock != nil {
		// Keep the remote session lock alive even if the helper is killed while the
		// Docker CLI is still running. A new helper must wait for that child too.
		command.ExtraFiles = []*os.File{lock}
	}

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

func containerName(j Job) string { return "keel-target-" + j.TargetID + j.slot }

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
	if err != nil {
		return errors.New("cannot inspect target container ownership")
	}

	if strings.TrimSpace(string(label)) != j.TargetID {
		return errors.New("container ownership mismatch")
	}

	fence, err := a.docker(ctx, nil, "container", "inspect", "--format", `{{index .Config.Labels "keel.fence"}}`, containerName(j))
	if err != nil {
		return errors.New("cannot inspect target container fence")
	}

	currentFence, err := strconv.Atoi(strings.TrimSpace(string(fence)))
	if err != nil {
		return errors.New("target container has no valid fence")
	}

	if currentFence > j.Fence {
		return errors.New("target fence is newer than this lease")
	}

	_, err = a.docker(ctx, nil, "container", "rm", "--force", "--volumes", containerName(j))
	return err
}

// archiveName normalises an entry name to the path Docker resolves after extraction.
func archiveName(name string) (string, bool) {
	if path.IsAbs(name) || slices.Contains(strings.Split(name, "/"), "..") {
		return "", false
	}

	return path.Clean(name), true
}

// Read metadata without extracting any paths from the publisher's archive.
func verifyImageArchive(data []byte, imageID string) error {
	reader := tar.NewReader(bytes.NewReader(data))
	types := map[string]byte{}
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

		name, ok := archiveName(header.Name)
		if !ok {
			return errors.New("unsafe image archive entry")
		}

		// docker save writes directories, regular files and, in the legacy layout,
		// links that deduplicate layers. Anything else cannot be a genuine export.
		switch header.Typeflag {
		case tar.TypeXGlobalHeader:
			continue
		case tar.TypeDir:
			if name == "." {
				continue
			}
		case tar.TypeReg, tar.TypeSymlink, tar.TypeLink:
			if name == "." {
				return errors.New("unsafe image archive entry")
			}
		default:
			return errors.New("unsupported image archive entry")
		}

		// Names are compared after normalisation so that "./manifest.json" or a link
		// cannot shadow the entry that was hashed.
		if _, duplicate := types[name]; duplicate {
			return errors.New("duplicate image archive entry")
		}

		types[name] = header.Typeflag
		if header.Typeflag != tar.TypeReg {
			continue
		}

		content, err := io.ReadAll(io.LimitReader(reader, archiveLimit+1))
		if err != nil || len(content) > archiveLimit {
			return errors.New("invalid image archive entry")
		}

		digest := sha256.Sum256(content)
		files[name] = "sha256:" + hex.EncodeToString(digest[:])
		if name == "manifest.json" {
			manifest = content
		}
	}

	// An entry below a link or file could resolve somewhere other than the hashed entry.
	for name := range types {
		for dir := path.Dir(name); dir != "."; dir = path.Dir(dir) {
			if kind, ok := types[dir]; ok && kind != tar.TypeDir {
				return errors.New("image archive entry is nested under a non-directory")
			}
		}
	}

	var images []struct {
		Config string `json:"Config"`
	}

	if json.Unmarshal(manifest, &images) != nil || len(images) != 1 {
		return errors.New("archive must contain one image matching the release image ID")
	}

	config, ok := archiveName(images[0].Config)
	if !ok || files[config] != imageID {
		return errors.New("archive must contain one image matching the release image ID")
	}

	return nil
}

func (a *Agent) deploy(ctx context.Context, j Job, t Target) string {
	a.progress(ctx, j, "downloading")
	artifact, err := a.request(ctx, "artifact", j.Lease)
	if leaseRejected(err) {
		log.Printf("Artifact download for attempt %s was refused (%v)", j.AttemptID, err)
		return abortedCode
	}

	if err != nil {
		// No result code describes a failed transfer, so this keeps ARTIFACT_INVALID.
		// The log separates it from artifacts that were received but failed verification.
		log.Printf("Artifact download for attempt %s failed: %v", j.AttemptID, err)
		return "ARTIFACT_INVALID"
	}

	digest := sha256.Sum256(artifact)
	if int64(len(artifact)) != j.Size || hex.EncodeToString(digest[:]) != j.Digest {
		log.Printf("Artifact for attempt %s does not match the release size and digest", j.AttemptID)
		return "ARTIFACT_INVALID"
	}

	artifact, err = imageArchive(artifact, j.ArchivePath)
	if err == nil {
		err = verifyImageArchive(artifact, j.ImageID)
	}

	if err != nil {
		log.Printf("Artifact for attempt %s failed verification: %v", j.AttemptID, err)
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

	// Fetch only after local target and image validation, before any destructive action.
	secretInput, err := a.deploymentSecrets(ctx, j)
	if err != nil {
		return "SECRET_UNAVAILABLE"
	}
	defer clear(secretInput)

	if j.Strategy == "blue-green" {
		return a.deployBlueGreen(ctx, j, t, secretInput)
	}

	// Recheck immediately before replacing the target. Heartbeats also cancel in-flight work.
	action, err := a.confirmLease(ctx, j)
	if err != nil {
		log.Printf("Lease for attempt %s could not be confirmed before replacing the target: %v", j.AttemptID, err)
		return abortedCode
	}

	if action != "continue" {
		return "CANCELLED"
	}

	a.progress(ctx, j, "replacing_container")
	if a.cleanup(ctx, j) != nil {
		return "DOCKER_FAILED"
	}

	return a.startAndVerify(ctx, j, t, secretInput)
}

func (a *Agent) startAndVerify(ctx context.Context, j Job, t Target, secretInput []byte) string {
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
	}

	var environment io.Reader
	if j.SecretCount > 0 {
		// Docker reads the env file from an anonymous pipe. Values never enter argv,
		// the agent's environment, a temporary file, or the persisted job contract.
		args = append(args, "--env-file", "/dev/stdin")
		environment = bytes.NewReader(secretInput)
	}
	args = append(args, j.ImageID)

	if _, err := a.docker(ctx, environment, args...); err != nil {
		return "DOCKER_FAILED"
	}

	if _, err := a.docker(ctx, nil, "container", "start", containerName(j)); err != nil {
		return "DOCKER_FAILED"
	}

	a.progress(ctx, j, "verifying_http")
	health := a.health
	if health == nil {
		health = localHealth
	}

	for tries := 0; tries < 30; tries++ {
		if ctx.Err() != nil {
			return abortCode(ctx)
		}

		if health(ctx, t.HostPort, j.HealthPath) {
			state, inspectErr := a.docker(ctx, nil, "container", "inspect", "--format", `{{.State.Running}} {{index .Config.Labels "keel.attempt"}} {{index .Config.Labels "keel.fence"}} {{.Image}}`, containerName(j))
			expected := fmt.Sprintf("true %s %d %s", j.AttemptID, j.Fence, j.ImageID)
			if inspectErr == nil && strings.TrimSpace(string(state)) == expected {
				return "HTTP_VERIFIED"
			}
		}

		select {
		case <-ctx.Done():
			return abortCode(ctx)
		case <-time.After(time.Second):
		}
	}

	return "HEALTH_FAILED"
}

func localHealth(ctx context.Context, port int, healthPath string) bool {
	client := &http.Client{
		Timeout:   2 * time.Second,
		Transport: &http.Transport{Proxy: nil},
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	defer client.CloseIdleConnections()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, fmt.Sprintf("http://127.0.0.1:%d%s", port, healthPath), nil)
	if err != nil {
		return false
	}
	response, err := client.Do(req)
	if err != nil {
		return false
	}
	defer response.Body.Close()
	return response.StatusCode == 200
}
