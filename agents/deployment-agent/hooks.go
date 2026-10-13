package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

type LifecycleHook struct {
	Command        []string `json:"command"`
	TimeoutSeconds int      `json:"timeoutSeconds"`
	Secrets        []string `json:"secrets,omitempty"`
	Network        string   `json:"network,omitempty"`
}

type LifecycleHooks struct {
	PreDeploy  *LifecycleHook `json:"preDeploy,omitempty"`
	PostDeploy *LifecycleHook `json:"postDeploy,omitempty"`
}

func validateHooks(hooks *LifecycleHooks) error {
	if hooks == nil {
		return nil
	}

	if hooks.PreDeploy == nil && hooks.PostDeploy == nil {
		return errors.New("empty lifecycle hooks")
	}

	for _, hook := range []*LifecycleHook{hooks.PreDeploy, hooks.PostDeploy} {
		if hook == nil {
			continue
		}

		if len(hook.Command) < 1 || len(hook.Command) > 32 || hook.TimeoutSeconds < 1 || hook.TimeoutSeconds > 120 || len(hook.Secrets) > secretLimit {
			return errors.New("invalid hook execution limits")
		}

		for _, argument := range hook.Command {
			if len(argument) == 0 || utf8.RuneCountInString(argument) > 256 || !utf8.ValidString(argument) || strings.ContainsFunc(argument, func(c rune) bool { return c < 32 || c == 127 }) {
				return errors.New("invalid hook command")
			}
		}

		if hook.Network != "" && hook.Network != "none" && hook.Network != "target" {
			return errors.New("invalid hook network")
		}

		names := map[string]bool{}
		for _, name := range hook.Secrets {
			if !secretVariable.MatchString(name) || names[name] {
				return errors.New("invalid hook secret selection")
			}
			names[name] = true
		}
	}

	return nil
}

type lifecycleState struct {
	Attempt            string `json:"attempt"`
	Fence              int    `json:"fence"`
	ApplicationStarted bool   `json:"application_started"`
}

func (a *Agent) lifecyclePath(j Job) string {
	return filepath.Join(a.config.StateDirectory, "lifecycle-"+j.TargetID+".json")
}

func (a *Agent) readLifecycle(j Job) (lifecycleState, error) {
	var state lifecycleState
	data, err := os.ReadFile(a.lifecyclePath(j))
	if os.IsNotExist(err) {
		return state, nil
	}

	if err != nil {
		return state, err
	}

	if json.Unmarshal(data, &state) != nil || !uuidPattern.MatchString(state.Attempt) || state.Fence < 1 {
		return state, errors.New("invalid lifecycle state")
	}

	return state, nil
}

// Written before hooks can start. Interrupted work receives cleanup only; the
// journal distinguishes a pre-hook interruption from application replacement.
func (a *Agent) prepareLifecycle(j Job) error {
	state, err := a.readLifecycle(j)
	if err != nil {
		return err
	}

	if state.Fence > j.Fence || (state.Fence == j.Fence && state.Attempt != j.AttemptID) {
		return errors.New("stale lifecycle attempt")
	}

	if j.Mode == "deploy" && state.Attempt == j.AttemptID {
		return errors.New("hook attempt cannot be replayed")
	}

	// An older attempt's journal means this assignment never reached preparation.
	// Its application belongs to that older attempt and must remain untouched.
	if j.Mode == "deploy" || state.Attempt != j.AttemptID {
		state = lifecycleState{Attempt: j.AttemptID}
	}

	state.Fence = j.Fence

	return writeStateFile(a.lifecyclePath(j), state)
}

func (a *Agent) applicationStarted(j Job) (bool, error) {
	state, err := a.readLifecycle(j)
	if err != nil {
		return false, err
	}

	if state.Attempt != j.AttemptID || state.Fence != j.Fence {
		return false, errors.New("lifecycle fence mismatch")
	}

	return state.ApplicationStarted, nil
}

func (a *Agent) markApplicationStarted(j Job) error {
	if j.Hooks == nil {
		return nil
	}

	if _, err := a.applicationStarted(j); err != nil {
		return err
	}

	return writeStateFile(a.lifecyclePath(j), lifecycleState{Attempt: j.AttemptID, Fence: j.Fence, ApplicationStarted: true})
}

func hookJob(j Job, phase string) Job {
	j.slot = "-hook-" + j.AttemptID + "-" + phase
	return j
}

func (a *Agent) cleanupHooks(ctx context.Context, j Job) error {
	for _, phase := range []string{"pre", "post"} {
		if err := a.cleanup(ctx, hookJob(j, phase)); err != nil {
			return err
		}
	}

	return nil
}

// Selection copies only explicitly requested variables. Both buffers are cleared
// by their owners; secret values never enter Docker arguments or a state file.
func hookEnvironment(input []byte, names []string) ([]byte, error) {
	var output []byte
	for _, name := range names {
		found := false
		for _, line := range bytes.Split(input, []byte{'\n'}) {
			separator := bytes.IndexByte(line, '=')
			if separator > 0 && string(line[:separator]) == name {
				output = append(output, line...)
				output = append(output, '\n')
				found = true
				break
			}
		}

		if !found {
			clear(output)
			return nil, errors.New("hook secret unavailable")
		}
	}

	return output, nil
}

func (a *Agent) runHook(parent context.Context, j Job, t Target, phase string, hook *LifecycleHook, secrets []byte) (code string) {
	if hook == nil {
		return ""
	}

	prefix := strings.ToUpper(phase) + "_HOOK_"
	code = prefix + "FAILED"
	environment, err := hookEnvironment(secrets, hook.Secrets)
	if err != nil {
		return "SECRET_UNAVAILABLE"
	}

	defer clear(environment)

	action, err := a.confirmLease(parent, j)
	if err != nil {
		return abortedCode
	}

	if action != "continue" {
		return "CANCELLED"
	}

	ctx, cancel := context.WithTimeout(parent, time.Duration(hook.TimeoutSeconds)*time.Second)
	defer cancel()
	defer func() {
		cleanup, stop := context.WithTimeout(context.Background(), 15*time.Second)
		defer stop()
		if err := a.cleanup(cleanup, hookJob(j, phase)); err != nil && code == "" {
			code = prefix + "FAILED"
		}
	}()
	a.progress(ctx, j, phase+"_hook")
	network := "none"
	if hook.Network == "target" {
		network = t.HookNetwork
	}

	args := []string{
		"container", "create", "--name", containerName(hookJob(j, phase)),
		"--label", "keel.target=" + j.TargetID,
		"--label", "keel.attempt=" + j.AttemptID,
		"--label", "keel.fence=" + strconv.Itoa(j.Fence),
		"--init", "--read-only", "--user", "65532:65532", "--cap-drop", "ALL",
		"--security-opt", "no-new-privileges", "--memory", "256m", "--memory-swap", "256m",
		"--cpus", "1", "--pids-limit", "64", "--restart", "no",
		"--log-driver", "none", "--network", network,
		"--tmpfs", "/tmp:rw,noexec,nosuid,size=16m,mode=1777",
	}
	var input io.Reader
	if len(environment) > 0 {
		args = append(args, "--env-file", "/dev/stdin")
		input = bytes.NewReader(environment)
	}
	// The image supplies BusyBox/GNU timeout at this fixed path. Its timer lives
	// inside the container and survives an agent or SSH connection loss. Docker's
	// init keeps timeout away from PID 1's special signal handling and reaps children.
	args = append(args, "--entrypoint", "/bin/timeout", j.ImageID, "-s", "KILL", "--", strconv.Itoa(hook.TimeoutSeconds))
	args = append(args, hook.Command...)
	if _, err = a.docker(ctx, input, args...); err == nil {
		_, err = a.docker(ctx, nil, "container", "start", containerName(hookJob(j, phase)))
	}

	for err == nil && ctx.Err() == nil {
		var status []byte
		status, err = a.docker(ctx, nil, "container", "inspect", "--format", `{{.State.Status}} {{.State.ExitCode}} {{index .Config.Labels "keel.attempt"}} {{index .Config.Labels "keel.fence"}} {{.Image}}`, containerName(hookJob(j, phase)))
		if err != nil {
			break
		}

		fields := strings.Fields(string(status))
		if len(fields) != 5 || strings.Join(fields[2:], " ") != fmt.Sprintf("%s %d %s", j.AttemptID, j.Fence, j.ImageID) {
			break
		}

		if fields[0] == "exited" {
			if fields[1] == "0" {
				return ""
			}
			break
		}

		if fields[0] != "running" && fields[0] != "created" {
			break
		}

		if !wait(ctx, 200*time.Millisecond) {
			break
		}
	}

	if parent.Err() != nil {
		return abortCode(parent)
	}

	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return prefix + "TIMEOUT"
	}

	return code
}
