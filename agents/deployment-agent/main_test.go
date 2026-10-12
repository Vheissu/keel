package main

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"strings"
	"testing"
)

func job() Job {
	return Job{Lease: Lease{AttemptID: "12345678-1234-1234-1234-123456789abc", Fence: 2, Token: strings.Repeat("a", 64)}, Mode: "deploy", TargetID: "12345678-1234-1234-1234-123456789def", Digest: strings.Repeat("b", 64), Size: 100, ImageID: "sha256:" + strings.Repeat("c", 64), HealthPath: "/health"}
}

func TestContractValidation(t *testing.T) {
	valid := job()
	if err := validateJob(valid); err != nil {
		t.Fatal(err)
	}

	for _, path := range []string{"//evil.test/health", "https://evil.test/health", "/health#fragment", "/\nInjected"} {
		j := valid
		j.HealthPath = path
		if validateJob(j) == nil {
			t.Fatalf("accepted unsafe health path %q", path)
		}
	}

	for _, image := range []string{"latest", "--privileged", "sha256:abc", strings.Repeat("c", 64)} {
		j := valid
		j.ImageID = image
		if validateJob(j) == nil {
			t.Fatalf("accepted unpinned image %q", image)
		}
	}

	valid.TargetID = "../foreign"
	if validateJob(valid) == nil {
		t.Fatal("accepted invalid target")
	}
}

func TestArchivePinsImageConfiguration(t *testing.T) {
	config := []byte(`{"architecture":"arm64","config":{"Cmd":["httpd"]}}`)
	digest := sha256.Sum256(config)
	imageID := "sha256:" + hex.EncodeToString(digest[:])
	var data bytes.Buffer
	writer := tar.NewWriter(&data)
	for name, content := range map[string][]byte{"config.json": config, "manifest.json": []byte(`[{"Config":"config.json","Layers":[]}]`)} {
		if err := writer.WriteHeader(&tar.Header{Name: name, Mode: 0600, Size: int64(len(content))}); err != nil {
			t.Fatal(err)
		}

		if _, err := writer.Write(content); err != nil {
			t.Fatal(err)
		}
	}

	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}

	if err := verifyImageArchive(data.Bytes(), imageID); err != nil {
		t.Fatal(err)
	}

	if verifyImageArchive(data.Bytes(), "sha256:"+strings.Repeat("a", 64)) == nil {
		t.Fatal("accepted image substitution")
	}

	if verifyImageArchive([]byte("not a tar"), imageID) == nil {
		t.Fatal("accepted invalid archive")
	}
}

func TestCleanupRefusesForeignOrNewerContainers(t *testing.T) {
	for _, scenario := range []struct{ name, label, fence string }{
		{"foreign", "other-target", "1"},
		{"newer", job().TargetID, "3"},
		{"unfenced", job().TargetID, ""},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			agent := Agent{docker: func(_ context.Context, _ io.Reader, args ...string) ([]byte, error) {
				joined := strings.Join(args, " ")
				if strings.Contains(joined, "container rm") {
					t.Fatal("removed an unowned container")
				}

				if strings.Contains(joined, "container ls") {
					return []byte("abc"), nil
				}

				if strings.Contains(joined, "keel.target") {
					return []byte(scenario.label), nil
				}

				return []byte(scenario.fence), nil
			}}
			if agent.cleanup(context.Background(), job()) == nil {
				t.Fatal("cleanup claimed success")
			}
		})
	}
}

func TestCleanupRequiresWorkingDaemon(t *testing.T) {
	agent := Agent{docker: func(context.Context, io.Reader, ...string) ([]byte, error) {
		return nil, fmt.Errorf("daemon unavailable")
	}}
	if agent.cleanup(context.Background(), job()) == nil {
		t.Fatal("daemon failure treated as absent container")
	}
}

func TestOutputIsBounded(t *testing.T) {
	var output cappedBuffer
	payload := bytes.Repeat([]byte("x"), 100000)
	count, err := output.Write(payload)
	if err != nil || count != len(payload) || output.Len() != 65536 {
		t.Fatal("output was not bounded")
	}
}
