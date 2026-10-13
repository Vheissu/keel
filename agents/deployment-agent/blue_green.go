package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Routes contain no secrets. Both slots stay running after a switch; the next
// deployment replaces the inactive slot. Recovery can therefore restore the old
// route without recreating its container or resolving its secret versions again.
type blueGreenRoute struct {
	Slot    string `json:"slot"`
	Attempt string `json:"attempt"`
}

type blueGreenState struct {
	Fence    int            `json:"fence"`
	Active   blueGreenRoute `json:"active"`
	Previous blueGreenRoute `json:"previous"`
}

func validRoute(route blueGreenRoute) bool {
	return route == (blueGreenRoute{}) ||
		((route.Slot == "-blue" || route.Slot == "-green") && uuidPattern.MatchString(route.Attempt))
}

func (a *Agent) routePath(targetID string) string {
	return filepath.Join(a.config.StateDirectory, "route-"+targetID+".json")
}

func (a *Agent) readRoute(targetID string) (blueGreenState, error) {
	var state blueGreenState
	data, err := os.ReadFile(a.routePath(targetID))
	if os.IsNotExist(err) {
		return state, nil
	}

	if err != nil {
		return state, err
	}

	if json.Unmarshal(data, &state) != nil || state.Fence < 1 || !validRoute(state.Active) || !validRoute(state.Previous) ||
		(state.Previous.Slot != "" && (state.Active.Slot == "" || state.Previous.Slot == state.Active.Slot)) {
		return state, errors.New("invalid persisted blue/green route")
	}

	return state, nil
}

// Persist before routing or deleting containers. Atomic rename lets requests see
// either complete route, while fsync makes a confirmed recovery survive a restart.
func (a *Agent) writeRoute(targetID string, state blueGreenState) error {
	data, err := json.Marshal(state)
	if err != nil {
		return err
	}

	file, err := os.CreateTemp(a.config.StateDirectory, ".route-*")
	if err != nil {
		return err
	}

	defer os.Remove(file.Name())
	defer file.Close()
	if _, err = file.Write(data); err != nil {
		return err
	}

	if err = file.Sync(); err != nil {
		return err
	}

	if err = file.Close(); err != nil {
		return err
	}

	if err = os.Rename(file.Name(), a.routePath(targetID)); err != nil {
		return err
	}

	directory, err := os.Open(a.config.StateDirectory)
	if err != nil {
		return err
	}

	defer directory.Close()
	return directory.Sync()
}

// execute holds the target lock throughout this fence update and every mutation.
func (a *Agent) fenceBlueGreen(j Job) error {
	state, err := a.readRoute(j.TargetID)
	if err != nil {
		return err
	}

	if state.Fence > j.Fence {
		return errors.New("persisted target fence is newer than this lease")
	}

	state.Fence = j.Fence
	return a.writeRoute(j.TargetID, state)
}

func slotPort(t Target, slot string) int {
	if slot == "-blue" {
		return t.BlueGreen.BluePort
	}

	return t.BlueGreen.GreenPort
}

func (a *Agent) deployBlueGreen(ctx context.Context, j Job, t Target, secretInput []byte) string {
	state, err := a.readRoute(j.TargetID)
	if err != nil || state.Fence != j.Fence {
		return "DOCKER_FAILED"
	}

	// A restarted process must receive cleanup, never blindly repeat a switch.
	if state.Active.Attempt == j.AttemptID {
		return "DOCKER_FAILED"
	}

	j.slot = "-blue"
	if state.Active.Slot == j.slot {
		j.slot = "-green"
	}

	action, err := a.confirmLease(ctx, j)
	if err != nil {
		return abortedCode
	}

	if action != "continue" {
		return "CANCELLED"
	}
	a.progress(ctx, j, "starting_candidate")
	if a.cleanup(ctx, j) != nil {
		return "DOCKER_FAILED"
	}

	candidate := t
	candidate.HostPort = slotPort(t, j.slot)
	if code := a.startAndVerify(ctx, j, candidate, secretInput); code != "HTTP_VERIFIED" {
		return code
	}

	action, err = a.confirmLease(ctx, j)
	if err != nil {
		return abortedCode
	}

	if action != "continue" {
		return "CANCELLED"
	}
	a.progress(ctx, j, "switching_traffic")
	state.Previous = state.Active
	state.Active = blueGreenRoute{Slot: j.slot, Attempt: j.AttemptID}
	if a.writeRoute(j.TargetID, state) != nil {
		return "DOCKER_FAILED"
	}

	// Verify through the public target route as well as directly on the candidate.
	if !localHealth(ctx, t.HostPort, j.HealthPath) {
		return "HEALTH_FAILED"
	}

	if ctx.Err() != nil {
		return abortCode(ctx)
	}

	return "HTTP_VERIFIED"
}

func (a *Agent) recoverBlueGreen(ctx context.Context, j Job) (string, error) {
	state, err := a.readRoute(j.TargetID)
	if err != nil {
		return "", err
	}

	if state.Fence != j.Fence {
		return "", errors.New("blue/green recovery fence mismatch")
	}

	if state.Active.Attempt == j.AttemptID {
		state.Active = state.Previous
		state.Previous = blueGreenRoute{}
		if err = a.writeRoute(j.TargetID, state); err != nil {
			return "", err
		}
	}

	for _, slot := range []string{"-blue", "-green"} {
		j.slot = slot
		ids, err := a.docker(ctx, nil, "container", "ls", "--all", "--filter", "name=^/"+containerName(j)+"$", "--format", "{{.ID}}")
		if err != nil {
			return "", err
		}

		if strings.TrimSpace(string(ids)) == "" {
			continue
		}

		owner, err := a.docker(ctx, nil, "container", "inspect", "--format", `{{index .Config.Labels "keel.attempt"}}`, containerName(j))
		if err != nil {
			return "", err
		}

		if strings.TrimSpace(string(owner)) == j.AttemptID {
			if slot == state.Active.Slot {
				return "", errors.New("refusing to delete the active recovery route")
			}

			if err = a.cleanup(ctx, j); err != nil {
				return "", err
			}
		}
	}

	if state.Active.Slot == "" {
		return "no_previous_route", nil
	}

	return "previous_route_restored", nil
}

// The listener is deliberately loopback-only. An operator's ingress terminates
// TLS and forwards HTTP here. Route reads are atomic and continue during gateway
// outages; existing requests retain their selected backend across a switch.
func (a *Agent) startProxies() (func(), error) {
	var servers []*http.Server
	var transports []*http.Transport
	closeAll := func() {
		for _, server := range servers {
			_ = server.Close()
		}

		for _, transport := range transports {
			transport.CloseIdleConnections()
		}
	}

	for targetID, target := range a.config.Targets {
		if target.BlueGreen == nil {
			continue
		}

		if _, err := a.readRoute(targetID); err != nil {
			closeAll()
			return nil, err
		}

		transport := &http.Transport{
			Proxy:                 nil,
			DialContext:           (&net.Dialer{Timeout: 5 * time.Second}).DialContext,
			ResponseHeaderTimeout: 30 * time.Second,
			IdleConnTimeout:       60 * time.Second,
		}

		transports = append(transports, transport)
		proxy := &httputil.ReverseProxy{
			Transport: transport,
			Rewrite: func(request *httputil.ProxyRequest) {
				port := request.In.Context().Value(blueGreenPortKey{}).(int)
				request.SetURL(&url.URL{Scheme: "http", Host: "127.0.0.1:" + strconv.Itoa(port)})
				request.SetXForwarded()
			},
			ErrorHandler: func(w http.ResponseWriter, _ *http.Request, _ error) {
				http.Error(w, "Target unavailable", http.StatusBadGateway)
			},
		}

		handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			state, err := a.readRoute(targetID)
			if err != nil || state.Active.Slot == "" {
				http.Error(w, "No active deployment", http.StatusServiceUnavailable)
				return
			}

			ctx := context.WithValue(r.Context(), blueGreenPortKey{}, slotPort(target, state.Active.Slot))
			proxy.ServeHTTP(w, r.WithContext(ctx))
		})
		listener, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", target.HostPort))
		if err != nil {
			closeAll()
			return nil, err
		}

		server := &http.Server{Handler: handler, ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 65536}
		servers = append(servers, server)
		go func() { _ = server.Serve(listener) }()
	}

	return closeAll, nil
}

type blueGreenPortKey struct{}
