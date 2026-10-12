package main

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
)

func TestSecretEnvironmentPreservesLiteralValues(t *testing.T) {
	value := ` spaces = # $ " ' \ and Unicode λ `
	data, _ := json.Marshal(map[string]any{"values": map[string]string{"APP_PASSWORD": value}})
	environment, err := secretEnvironment(data, 1)
	if err != nil || string(environment) != "APP_PASSWORD="+value+"\n" {
		t.Fatal("secret value was transformed")
	}
}

func TestSecretEnvironmentRejectsInjectionAndOversizedValues(t *testing.T) {
	for _, value := range []string{"", "line\nINJECTED=value", "line\rINJECTED=value", "nul\x00value", strings.Repeat("x", 8193)} {
		data, _ := json.Marshal(map[string]any{"values": map[string]string{"APP_PASSWORD": value}})
		if _, err := secretEnvironment(data, 1); err == nil || strings.Contains(err.Error(), value) && value != "" {
			t.Fatal("unsafe value accepted or disclosed")
		}
	}
	for _, name := range []string{"lower", "--privileged", "A=B", "A\nB"} {
		data, _ := json.Marshal(map[string]any{"values": map[string]string{name: "private"}})
		if _, err := secretEnvironment(data, 1); err == nil {
			t.Fatal("unsafe variable name accepted")
		}
	}
	for _, input := range []string{`{"values":{}}`, `{"values":{"A":"value","B":"value"}}`, `{"values":{"A":123}}`, `{"values":{"A":"value"},"extra":true}`} {
		if _, err := secretEnvironment([]byte(input), 1); err == nil {
			t.Fatal("invalid secret response accepted")
		}
	}
}

func secretArchive(t *testing.T) ([]byte, string) {
	t.Helper()
	config := []byte(`{"architecture":"arm64","config":{"Cmd":["httpd"]}}`)
	digest := sha256.Sum256(config)
	var archive bytes.Buffer
	writer := tar.NewWriter(&archive)
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
	return archive.Bytes(), "sha256:" + hex.EncodeToString(digest[:])
}

func TestAgentDeliversSecretsOnlyThroughDockerStdin(t *testing.T) {
	for _, available := range []bool{true, false} {
		t.Run(fmt.Sprint(available), func(t *testing.T) {
			archive, imageID := secretArchive(t)
			j := job()
			j.ImageID = imageID
			j.Size = int64(len(archive))
			digest := sha256.Sum256(archive)
			j.Digest = hex.EncodeToString(digest[:])
			j.SecretCount = 1
			const secret = "private-agent-secret = # $ value"
			var result Result
			gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/agent/v1/artifact":
					_, _ = w.Write(archive)
				case "/agent/v1/secrets":
					var lease Lease
					if json.NewDecoder(r.Body).Decode(&lease) != nil || lease != j.Lease {
						t.Error("secret request omitted scoped lease")
					}
					if !available {
						w.WriteHeader(http.StatusConflict)
						return
					}
					_ = json.NewEncoder(w).Encode(map[string]any{"values": map[string]string{"APP_PASSWORD": secret}})
				case "/agent/v1/heartbeat":
					_, _ = io.WriteString(w, `{"action":"continue"}`)
				case "/agent/v1/result":
					_ = json.NewDecoder(r.Body).Decode(&result)
				default:
					_, _ = io.WriteString(w, `{}`)
				}
			}))
			defer gateway.Close()
			address, _ := url.Parse(gateway.URL)
			port, _ := strconv.Atoi(address.Port())
			created := false
			var logs bytes.Buffer
			previousOutput := log.Writer()
			log.SetOutput(&logs)
			defer log.SetOutput(previousOutput)
			a := Agent{
				config: Config{Gateway: gateway.URL, Targets: map[string]Target{j.TargetID: {HostPort: port, ContainerPort: 8080}}},
				client: gateway.Client(),
				docker: func(_ context.Context, input io.Reader, args ...string) ([]byte, error) {
					command := strings.Join(args, " ")
					if strings.Contains(command, secret) {
						t.Fatal("secret appeared in command arguments")
					}
					if !available && strings.Contains(command, "container") {
						t.Fatal("secret failure touched the existing container")
					}
					if strings.Contains(command, "image inspect") {
						return []byte(imageID), nil
					}
					if strings.Contains(command, "container create") {
						created = true
						if !strings.Contains(command, "--env-file /dev/stdin") || input == nil {
							t.Fatal("secret environment did not use stdin")
						}
						data, _ := io.ReadAll(input)
						if string(data) != "APP_PASSWORD="+secret+"\n" {
							t.Fatal("secret environment was changed")
						}
						// Even hostile Docker output is never forwarded to logs or the gateway.
						return []byte(secret), nil
					}
					if strings.Contains(command, "container inspect") {
						return []byte(fmt.Sprintf("true %s %d %s", j.AttemptID, j.Fence, imageID)), nil
					}
					return nil, nil
				},
			}
			a.execute(context.Background(), j)
			if available && (!created || result.Code != "HTTP_VERIFIED") {
				t.Fatalf("secret deployment failed: %s", result.Code)
			}
			if !available && (created || result.Code != "SECRET_UNAVAILABLE") {
				t.Fatal("secret failure did not preserve the previous application")
			}
			if strings.Contains(logs.String(), secret) {
				t.Fatal("secret appeared in agent logs")
			}
		})
	}
}
