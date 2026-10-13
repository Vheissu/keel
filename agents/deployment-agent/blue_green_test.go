package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strconv"
	"strings"
	"testing"
)

func TestBlueGreenRecoveryIsDurableAndFenced(t *testing.T) {
	for _, switched := range []bool{false, true} {
		t.Run(fmt.Sprint(switched), func(t *testing.T) {
			j := job()
			old := blueGreenRoute{Slot: "-blue", Attempt: "12345678-1234-1234-1234-123456789aaa"}
			state := blueGreenState{Fence: j.Fence, Active: old}
			if switched {
				state.Active = blueGreenRoute{Slot: "-green", Attempt: j.AttemptID}
				state.Previous = old
			}

			agent := &Agent{config: Config{StateDirectory: t.TempDir()}}
			if err := agent.writeRoute(j.TargetID, state); err != nil {
				t.Fatal(err)
			}

			removed := false
			agent.docker = func(_ context.Context, _ io.Reader, args ...string) ([]byte, error) {
				name := args[len(args)-1]
				switch args[1] {
				case "ls":
					if strings.Contains(strings.Join(args, " "), "-green") && !removed {
						return []byte("candidate"), nil
					}

					return nil, nil
				case "inspect":
					if !strings.HasSuffix(name, "-green") {
						t.Fatal("inspected previous container")
					}
					switch {
					case strings.Contains(args[3], "keel.attempt"):
						return []byte(j.AttemptID), nil
					case strings.Contains(args[3], "keel.target"):
						return []byte(j.TargetID), nil
					case strings.Contains(args[3], "keel.fence"):
						return []byte(strconv.Itoa(j.Fence)), nil
					}
				case "rm":
					current, err := agent.readRoute(j.TargetID)
					if err != nil || current.Active != old {
						t.Fatal("deleted candidate before restoring route")
					}

					if !strings.HasSuffix(name, "-green") {
						t.Fatal("deleted previous container")
					}

					removed = true
					return nil, nil
				}

				return nil, errors.New("unexpected Docker command")
			}

			for range 2 {
				recovery, err := agent.recoverBlueGreen(context.Background(), j)
				if err != nil || recovery != "previous_route_restored" {
					t.Fatalf("recovery %s: %v", recovery, err)
				}
			}

			if !removed {
				t.Fatal("candidate not removed")
			}

			restarted := &Agent{config: agent.config}
			persisted, err := restarted.readRoute(j.TargetID)
			if err != nil || persisted.Active != old {
				t.Fatal("route not persisted")
			}

			stale := j
			stale.Fence--
			if restarted.fenceBlueGreen(stale) == nil {
				t.Fatal("accepted stale fence")
			}

			if _, err := agent.recoverBlueGreen(context.Background(), stale); err == nil {
				t.Fatal("stale recovery accepted")
			}
		})
	}
}

func TestBlueGreenRecoveryFailsClosed(t *testing.T) {
	j := job()
	agent := &Agent{config: Config{StateDirectory: t.TempDir()}}
	if err := agent.fenceBlueGreen(j); err != nil {
		t.Fatal(err)
	}

	agent.docker = func(context.Context, io.Reader, ...string) ([]byte, error) {
		return nil, errors.New("daemon unavailable")
	}

	if _, err := agent.recoverBlueGreen(context.Background(), j); err == nil {
		t.Fatal("reported recovery while Docker unavailable")
	}

	agent.docker = func(context.Context, io.Reader, ...string) ([]byte, error) { return nil, nil }
	recovery, err := agent.recoverBlueGreen(context.Background(), j)
	if err != nil || recovery != "no_previous_route" {
		t.Fatalf("unexpected empty recovery: %s %v", recovery, err)
	}

	if err := os.WriteFile(agent.routePath(j.TargetID), []byte("broken"), 0600); err != nil {
		t.Fatal(err)
	}

	if agent.fenceBlueGreen(j) == nil {
		t.Fatal("overwrote corrupted route")
	}
}

func TestBlueGreenProxyReadsAtomicRoutes(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Forwarded-Host") == "spoofed" {
			t.Error("trusted spoofed forwarded header")
		}

		_, _ = io.WriteString(w, r.URL.RequestURI())
	}))
	defer backend.Close()
	u, _ := url.Parse(backend.URL)
	port, _ := strconv.Atoi(u.Port())
	listener := httptest.NewServer(http.NotFoundHandler())
	proxyURL := listener.URL
	proxyOrigin, _ := url.Parse(proxyURL)
	hostPort, _ := strconv.Atoi(proxyOrigin.Port())
	listener.Close()
	j := job()
	agent := &Agent{config: Config{StateDirectory: t.TempDir(), Targets: map[string]Target{j.TargetID: {HostPort: hostPort, BlueGreen: &BlueGreenConfig{BluePort: port, GreenPort: port}}}}}
	for range 2 {
		closeProxies, err := agent.startProxies()
		if err != nil {
			t.Fatal(err)
		}

		response, err := http.Get(proxyURL)
		if err != nil {
			closeProxies()
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != 503 {
			t.Fatal("empty route did not fail closed")
		}

		state := blueGreenState{Fence: j.Fence, Active: blueGreenRoute{Slot: "-blue", Attempt: j.AttemptID}}
		if err := agent.writeRoute(j.TargetID, state); err != nil {
			t.Fatal(err)
		}

		response, err = http.Get(proxyURL + "/hello?q=world")
		if err != nil {
			closeProxies()
			t.Fatal(err)
		}

		body, _ := io.ReadAll(response.Body)
		response.Body.Close()
		if response.StatusCode != 200 || string(body) != "/hello?q=world" {
			t.Fatalf("proxy returned %d %s", response.StatusCode, body)
		}

		state.Active = blueGreenRoute{}
		if err := agent.writeRoute(j.TargetID, state); err != nil {
			t.Fatal(err)
		}
		closeProxies()
	}
}

func TestBlueGreenCompatibility(t *testing.T) {
	j := job()
	j.Strategy = "blue-green"
	if validateJob(j) == nil {
		t.Fatal("accepted blue/green on recreate capability")
	}

	j.Capability = "docker-blue-green-v1"
	if err := validateJob(j); err != nil {
		t.Fatal(err)
	}

	j.Strategy = "recreate"
	if validateJob(j) == nil {
		t.Fatal("accepted recreate on blue/green capability")
	}

	c := Config{Gateway: "https://gateway.test", StateDirectory: "/state", Certificate: "cert", Key: "key", CA: "ca", DockerSocket: "/docker.sock", Targets: map[string]Target{j.TargetID: {HostPort: 18080, ContainerPort: 8080, BlueGreen: &BlueGreenConfig{BluePort: 18081, GreenPort: 18082}}}}
	if err := validateConfig(c); err != nil {
		t.Fatal(err)
	}

	target := c.Targets[j.TargetID]
	target.BlueGreen.GreenPort = target.HostPort
	if validateConfig(c) == nil {
		t.Fatal("accepted colliding proxy/backend ports")
	}
}
