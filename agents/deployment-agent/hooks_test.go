package main

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"
)

func TestHookCreationFinishesBeforeTaskDeadlineOrCancellation(t *testing.T) {
	for _, cancelled := range []bool{false, true} {
		t.Run(fmt.Sprintf("cancelled=%v", cancelled), func(t *testing.T) {
			j := job()
			agent, _ := fakeGateway(t, func(w http.ResponseWriter, _ *http.Request, _ string, _ int) {
				_, _ = io.WriteString(w, `{"action":"continue"}`)
			})
			parent, cancel := context.WithCancelCause(context.Background())
			defer cancel(nil)
			created, started, removed := false, false, false
			agent.docker = func(ctx context.Context, _ io.Reader, args ...string) ([]byte, error) {
				switch args[1] {
				case "create":
					if cancelled {
						cancel(errCleanupRequested)
					}
					// Docker setup can take longer than a one-second task's runtime.
					if !wait(ctx, 1100*time.Millisecond) {
						t.Fatal("creation interrupted before Docker confirmed the container")
					}
					created = true
				case "start":
					started = true
				case "ls":
					if created {
						return []byte("hook"), nil
					}
				case "inspect":
					switch {
					case strings.Contains(args[3], ".State.Status"):
						return []byte(fmt.Sprintf("exited 0 %s %d %s", j.AttemptID, j.Fence, j.ImageID)), nil
					case strings.Contains(args[3], "keel.target"):
						return []byte(j.TargetID), nil
					case strings.Contains(args[3], "keel.fence"):
						return []byte(fmt.Sprint(j.Fence)), nil
					}
				case "rm":
					removed = true
				}
				return nil, nil
			}
			hook := &LifecycleHook{Command: []string{"/bin/task"}, TimeoutSeconds: 1}
			code := agent.runHook(parent, j, Target{}, "runbook", hook, nil)
			expected := ""
			if cancelled {
				expected = "CANCELLED"
			}
			if code != expected || !created || !removed || started == cancelled {
				t.Fatalf("code=%q created=%v started=%v removed=%v", code, created, started, removed)
			}
		})
	}
}

func TestHookExecutionLimitsAndSecretIsolation(t *testing.T) {
	for _, scenario := range []struct{ name, phase, network, status, code string }{
		{"success", "pre", "none", "exited 0", ""},
		{"network", "post", "target", "exited 0", ""},
		{"failure", "pre", "none", "exited 7", "PRE_HOOK_FAILED"},
		{"timeout", "pre", "none", "running 0", "PRE_HOOK_TIMEOUT"},
		{"post failure", "post", "none", "exited 7", "POST_HOOK_FAILED"},
		{"post timeout", "post", "none", "running 0", "POST_HOOK_TIMEOUT"},
		{"cancel", "pre", "none", "running 0", "CANCELLED"},
		{"runbook success", "runbook", "none", "exited 0", ""},
		{"runbook failure", "runbook", "none", "exited 7", "RUNBOOK_FAILED"},
		{"runbook timeout", "runbook", "none", "running 0", "RUNBOOK_TIMEOUT"},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			j := job()
			agent, _ := fakeGateway(t, func(w http.ResponseWriter, _ *http.Request, _ string, _ int) {
				_, _ = io.WriteString(w, `{"action":"continue"}`)
			})
			ctx, cancel := context.WithCancelCause(context.Background())
			defer cancel(nil)
			created, removed := false, false
			expectedNetwork := "none"
			if scenario.network == "target" {
				expectedNetwork = "release-tasks"
			}

			agent.docker = func(_ context.Context, input io.Reader, args ...string) ([]byte, error) {
				switch args[1] {
				case "create":
					created = true
					bytes, _ := io.ReadAll(input)
					expected := "WANTED=literal $ value\n"
					if scenario.phase == "runbook" {
						expected += "KEEL_INPUT_COUNT=0\nKEEL_INPUT_DRY_RUN=false\nKEEL_INPUT_EMPTY=\nKEEL_INPUT_LABEL=$(touch /not-created)\n"
					}
					if string(bytes) != expected {
						t.Fatalf("hook received unexpected secrets: %q", bytes)
					}

					command := strings.Join(args, " ")
					for _, flag := range []string{"--init", "--network " + expectedNetwork, "--log-driver none", "--read-only", "--memory 256m", "--memory-swap 256m", "--pids-limit 64", "--cpus 1", "--user 65532:65532", "--cap-drop ALL", "--security-opt no-new-privileges", "--entrypoint /bin/timeout"} {
						if !strings.Contains(command, flag) {
							t.Fatalf("missing limit %s", flag)
						}
					}

					if strings.Contains(command, "literal") || strings.Contains(command, "hidden") || strings.Contains(command, "not-created") {
						t.Fatal("secret in argv")
					}
				case "start":
					if scenario.name == "cancel" {
						cancel(errCleanupRequested)
					}
				case "inspect":
					switch {
					case strings.Contains(args[3], ".State.Status"):
						return []byte(fmt.Sprintf("%s %s %d %s", scenario.status, j.AttemptID, j.Fence, j.ImageID)), nil
					case strings.Contains(args[3], "keel.target"):
						return []byte(j.TargetID), nil
					case strings.Contains(args[3], "keel.fence"):
						return []byte(fmt.Sprint(j.Fence)), nil
					}
				case "ls":
					if created && !removed {
						return []byte("hook"), nil
					}
				case "rm":
					removed = true
				}

				return nil, nil
			}

			hook := &LifecycleHook{Command: []string{"/bin/task", "argument"}, TimeoutSeconds: 1, Secrets: []string{"WANTED"}, Network: scenario.network}
			if scenario.phase == "runbook" {
				j.Runbook = hook
				j.RunbookInputs = map[string]string{"COUNT": "0", "DRY_RUN": "false", "EMPTY": "", "LABEL": "$(touch /not-created)"}
			}
			code := agent.runHook(ctx, j, Target{HookNetwork: "release-tasks"}, scenario.phase, hook, []byte("WANTED=literal $ value\nOTHER=hidden\n"))
			if code != scenario.code || !removed {
				t.Fatalf("code=%q removed=%v", code, removed)
			}
		})
	}
}

func TestLifecycleJournalPreventsReplayAndPreservesPreHookApplication(t *testing.T) {
	agent := &Agent{config: Config{StateDirectory: t.TempDir()}}
	j := job()
	j.Hooks = &LifecycleHooks{PreDeploy: &LifecycleHook{Command: []string{"/bin/task"}, TimeoutSeconds: 1}}
	if err := agent.prepareLifecycle(j); err != nil {
		t.Fatal(err)
	}

	if started, err := agent.applicationStarted(j); err != nil || started {
		t.Fatal("pre-hook marked application started")
	}

	if agent.prepareLifecycle(j) == nil {
		t.Fatal("replayed hook attempt")
	}

	cleanup := j
	cleanup.Mode = "cleanup"
	cleanup.Fence++
	if err := agent.prepareLifecycle(cleanup); err != nil {
		t.Fatal(err)
	}

	if started, err := agent.applicationStarted(cleanup); err != nil || started {
		t.Fatal("recovery would remove old application")
	}

	if agent.markApplicationStarted(j) == nil {
		t.Fatal("stale lease changed journal")
	}

	if err := agent.markApplicationStarted(cleanup); err != nil {
		t.Fatal(err)
	}

	restarted := &Agent{config: agent.config}
	if started, err := restarted.applicationStarted(cleanup); err != nil || !started {
		t.Fatal("application marker did not survive restart")
	}

	if err := os.WriteFile(agent.lifecyclePath(j), []byte("broken"), 0600); err != nil {
		t.Fatal(err)
	}

	if agent.prepareLifecycle(cleanup) == nil {
		t.Fatal("corrupt journal overwritten")
	}
}

func TestHookContractAndMissingSecrets(t *testing.T) {
	for _, hook := range []*LifecycleHook{
		{Command: []string{"/bin/task"}, TimeoutSeconds: 0},
		{Command: []string{"/bin/task"}, TimeoutSeconds: 121},
		{Command: []string{}, TimeoutSeconds: 1},
		{Command: []string{"bad\ncommand"}, TimeoutSeconds: 1},
		{Command: []string{"/bin/task"}, TimeoutSeconds: 1, Network: "host"},
		{Command: []string{"/bin/task"}, TimeoutSeconds: 1, Secrets: []string{"KEY", "KEY"}},
	} {
		if validateHooks(&LifecycleHooks{PreDeploy: hook}) == nil {
			t.Fatalf("accepted invalid hook: %+v", hook)
		}
	}

	if _, err := hookEnvironment([]byte("KEY=value\n"), []string{"MISSING"}); err == nil {
		t.Fatal("missing secret accepted")
	}
	environment, err := hookEnvironment([]byte("KEY=value\n"), nil)
	if err != nil || len(environment) != 0 {
		t.Fatal("secrets inherited without opt-in")
	}
}

func TestLifecycleRecoveryBeforePreparationPreservesPriorApplication(t *testing.T) {
	agent := &Agent{config: Config{StateDirectory: t.TempDir()}}
	previous := job()
	previous.Hooks = &LifecycleHooks{PreDeploy: &LifecycleHook{Command: []string{"/bin/task"}, TimeoutSeconds: 1}}
	if err := agent.prepareLifecycle(previous); err != nil {
		t.Fatal(err)
	}

	if err := agent.markApplicationStarted(previous); err != nil {
		t.Fatal(err)
	}

	interrupted := previous
	interrupted.AttemptID = "00000000-0000-0000-0000-000000000099"
	interrupted.Mode = "cleanup"
	if agent.prepareLifecycle(interrupted) == nil {
		t.Fatal("different attempt reused the same fence")
	}

	interrupted.Fence += 2
	if err := agent.prepareLifecycle(interrupted); err != nil {
		t.Fatal(err)
	}

	if started, err := agent.applicationStarted(interrupted); err != nil || started {
		t.Fatal("cleanup before preparation would remove the previous application")
	}
}
