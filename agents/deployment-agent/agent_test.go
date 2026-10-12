package main

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

type handler func(w http.ResponseWriter, r *http.Request, path string, call int)

// fakeGateway serves the agent protocol and counts calls per endpoint.
func fakeGateway(t *testing.T, handle handler) (*Agent, func(string) int) {
	t.Helper()
	var mu sync.Mutex
	calls := map[string]int{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/agent/v1/")
		mu.Lock()
		calls[path]++
		call := calls[path]
		mu.Unlock()
		handle(w, r, path, call)
	}))
	t.Cleanup(server.Close)
	agent := &Agent{
		config: Config{Gateway: server.URL, Targets: map[string]Target{job().TargetID: {HostPort: 18080, ContainerPort: 8080}}},
		client: server.Client(),
	}
	return agent, func(path string) int {
		mu.Lock()
		defer mu.Unlock()
		return calls[path]
	}
}

func fastTimers(t *testing.T) {
	interval, delay := heartbeatInterval, retryDelay
	heartbeatInterval, retryDelay = 10*time.Millisecond, time.Millisecond
	t.Cleanup(func() { heartbeatInterval, retryDelay = interval, delay })
}

func TestMonitorLeaseToleratesTransientFailures(t *testing.T) {
	fastTimers(t)
	for _, scenario := range []struct {
		name   string
		status func(call int) int
		action string
		cause  error
		calls  int
	}{
		{"transient", func(call int) int { return map[bool]int{true: 503, false: 200}[call <= 2] }, "continue", nil, 0},
		{"persistent", func(int) int { return 503 }, "", errLeaseLost, maxHeartbeatFailures},
		{"stale", func(int) int { return 409 }, "", errLeaseLost, 1},
		{"revoked", func(int) int { return 401 }, "", errLeaseLost, 1},
		{"cleanup", func(int) int { return 200 }, "cleanup", errCleanupRequested, 1},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			agent, calls := fakeGateway(t, func(w http.ResponseWriter, _ *http.Request, _ string, call int) {
				w.WriteHeader(scenario.status(call))
				_, _ = io.WriteString(w, `{"action":"`+scenario.action+`"}`)
			})
			ctx, cancel := context.WithCancelCause(context.Background())
			done := make(chan struct{})
			go func() {
				agent.monitorLease(ctx, cancel, job())
				close(done)
			}()

			if scenario.cause == nil {
				time.Sleep(150 * time.Millisecond)
				if ctx.Err() != nil || calls("heartbeat") <= maxHeartbeatFailures {
					t.Fatalf("transient failures aborted the attempt: %v", context.Cause(ctx))
				}

				cancel(nil)
				<-done
				return
			}

			select {
			case <-done:
			case <-time.After(2 * time.Second):
				t.Fatal("monitor did not abort")
			}

			if !errors.Is(context.Cause(ctx), scenario.cause) || calls("heartbeat") != scenario.calls {
				t.Fatalf("cause %v after %d heartbeats", context.Cause(ctx), calls("heartbeat"))
			}
		})
	}
}

func TestAbortedAttemptsCleanUpAndReport(t *testing.T) {
	fastTimers(t)
	for _, scenario := range []struct {
		name      string
		heartbeat func(call int) (int, string)
		shutdown  bool
		expected  Result
	}{
		{"shutdown", func(int) (int, string) { return 200, "continue" }, true, Result{Outcome: "failed", Code: abortedCode}},
		{"lost lease", func(call int) (int, string) { return map[bool]int{true: 200, false: 409}[call == 1], "continue" }, false, Result{Outcome: "failed", Code: abortedCode}},
		{"cancelled", func(call int) (int, string) {
			return 200, map[bool]string{true: "continue", false: "cleanup"}[call == 1]
		}, false, Result{Outcome: "cancelled", Code: "CANCELLED"}},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			parent, shutdown := context.WithCancel(context.Background())
			defer shutdown()
			results := make(chan Result, 1)
			agent, _ := fakeGateway(t, func(w http.ResponseWriter, r *http.Request, path string, call int) {
				switch path {
				case "heartbeat":
					status, action := scenario.heartbeat(call)
					w.WriteHeader(status)
					_, _ = io.WriteString(w, `{"action":"`+action+`"}`)
				case "artifact":
					// The server only notices a client disconnect once the body is read.
					_, _ = io.Copy(io.Discard, r.Body)
					if scenario.shutdown {
						shutdown()
					}

					<-r.Context().Done()
				case "result":
					var result Result
					_ = json.NewDecoder(r.Body).Decode(&result)
					results <- result
					_, _ = io.WriteString(w, `{}`)
				default:
					_, _ = io.WriteString(w, `{}`)
				}
			})
			var cleaned bool
			agent.docker = func(_ context.Context, _ io.Reader, args ...string) ([]byte, error) {
				if strings.Join(args[:2], " ") != "container ls" {
					t.Fatalf("unexpected Docker call %v", args)
				}

				cleaned = true
				return nil, nil
			}

			agent.execute(parent, job())
			select {
			case result := <-results:
				if !cleaned || result.Outcome != scenario.expected.Outcome || result.Code != scenario.expected.Code {
					t.Fatalf("reported %s/%s, cleaned %v", result.Outcome, result.Code, cleaned)
				}
			default:
				t.Fatal("no result delivered")
			}
		})
	}
}

func TestResultDeliveryStopsOnRejection(t *testing.T) {
	fastTimers(t)
	for _, scenario := range []struct {
		status, calls int
		delivered     bool
	}{{200, 1, true}, {409, 1, false}, {400, 1, false}, {503, 3, false}} {
		agent, calls := fakeGateway(t, func(w http.ResponseWriter, _ *http.Request, _ string, _ int) {
			w.WriteHeader(scenario.status)
		})
		err := agent.deliver(Result{Lease: job().Lease, Outcome: "failed", Code: "HEALTH_FAILED"})
		if (err == nil) != scenario.delivered || calls("result") != scenario.calls {
			t.Fatalf("status %d: %d calls, error %v", scenario.status, calls("result"), err)
		}
	}
}

type entry struct {
	name, content, link string
	kind                byte
}

func imageTar(t *testing.T, entries ...entry) []byte {
	t.Helper()
	var data bytes.Buffer
	writer := tar.NewWriter(&data)
	for _, e := range entries {
		kind := e.kind
		if kind == 0 {
			kind = tar.TypeReg
		}

		header := &tar.Header{Name: e.name, Typeflag: kind, Linkname: e.link, Mode: 0600}
		if kind == tar.TypeReg {
			header.Size = int64(len(e.content))
		}

		if err := writer.WriteHeader(header); err != nil {
			t.Fatal(err)
		}

		if _, err := writer.Write([]byte(e.content)); err != nil {
			t.Fatal(err)
		}
	}

	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}

	return data.Bytes()
}

func TestArchiveEntriesAreNormalised(t *testing.T) {
	config := `{"architecture":"arm64"}`
	digest := sha256.Sum256([]byte(config))
	imageID := "sha256:" + hex.EncodeToString(digest[:])
	manifest := func(path string) entry {
		return entry{name: "manifest.json", content: `[{"Config":"` + path + `","Layers":[]}]`}
	}

	accepted := map[string][]entry{
		"dot prefix": {{name: "./", kind: tar.TypeDir}, {name: "./config.json", content: config}, {name: "./manifest.json", content: `[{"Config":"config.json"}]`}},
		"dot config": {{name: "config.json", content: config}, manifest("./config.json")},
		"oci layout": {{name: "blobs/", kind: tar.TypeDir}, {name: "blobs/sha256/", kind: tar.TypeDir}, {name: "blobs/sha256/c", content: config}, manifest("blobs/sha256/c")},
		"legacy layer link": {
			{name: "a/", kind: tar.TypeDir}, {name: "a/layer.tar", content: "layer"},
			{name: "b/", kind: tar.TypeDir}, {name: "b/layer.tar", kind: tar.TypeSymlink, link: "../a/layer.tar"},
			{name: "config.json", content: config}, manifest("config.json"),
		},
	}
	for name, entries := range accepted {
		if err := verifyImageArchive(imageTar(t, entries...), imageID); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
	}

	valid := []entry{{name: "config.json", content: config}, manifest("config.json")}
	rejected := map[string][]entry{
		"shadowed manifest": append(valid[:1:1], manifest("config.json"), entry{name: "./manifest.json", content: `[{"Config":"other.json"}]`}),
		"link before file":  {{name: "config.json", kind: tar.TypeSymlink, link: "other.json"}, valid[0], valid[1]},
		"link after file":   {valid[0], {name: "./config.json", kind: tar.TypeSymlink, link: "other.json"}, valid[1]},
		"directory clash":   {valid[0], {name: "config.json/", kind: tar.TypeDir}, valid[1]},
		"absolute":          {valid[0], valid[1], {name: "/etc/keel", content: "x"}},
		"parent":            {valid[0], valid[1], {name: "../keel", content: "x"}},
		"hidden parent":     {valid[0], valid[1], {name: "x/../keel", content: "x"}},
		"device":            {valid[0], valid[1], {name: "dev", kind: tar.TypeChar}},
		"under link":        {{name: "blobs", kind: tar.TypeSymlink, link: "/var/lib"}, {name: "blobs/config.json", content: config}, manifest("blobs/config.json")},
		"config escape":     {valid[0], manifest("../config.json")},
	}
	for name, entries := range rejected {
		if verifyImageArchive(imageTar(t, entries...), imageID) == nil {
			t.Fatalf("accepted %s", name)
		}
	}
}
