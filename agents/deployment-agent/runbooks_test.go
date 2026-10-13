package main

import (
	"fmt"
	"strings"
	"testing"
)

func TestRunbookInputTransportBounds(t *testing.T) {
	base := job()
	base.Operation = "runbook"
	base.Strategy = "task"
	base.HealthPath = ""
	base.Runbook = &LifecycleHook{Command: []string{"/bin/task"}, TimeoutSeconds: 30}
	base.RunbookInputs = map[string]string{"LABEL": `literal $(touch /not-created) = "value"`, "COUNT": "0", "DRY_RUN": "false", "EMPTY": ""}
	if err := validateJob(base); err != nil {
		t.Fatal(err)
	}

	many := map[string]string{}
	for n := 0; n < 17; n++ {
		many[fmt.Sprintf("INPUT_%d", n)] = "x"
	}

	for _, values := range []map[string]string{
		{"lowercase": "x"}, {"A=B": "x"}, {strings.Repeat("X", 49): "x"},
		{"VALUE": "x\nOTHER=injected"}, {"VALUE": "bad\x00value"},
		{"VALUE": strings.Repeat("x", 257)}, {"VALUE": string([]byte{255})}, many,
	} {
		invalid := base
		invalid.RunbookInputs = values
		if validateJob(invalid) == nil {
			t.Fatalf("accepted invalid input map: %v", values)
		}
	}

	collision := base
	collision.Runbook = &LifecycleHook{Command: []string{"/bin/task"}, TimeoutSeconds: 30, Secrets: []string{"KEEL_INPUT_LABEL"}}
	if validateJob(collision) == nil {
		t.Fatal("input replaced a secret variable")
	}

	deployment := job()
	deployment.RunbookInputs = base.RunbookInputs
	if validateJob(deployment) == nil {
		t.Fatal("deployment accepted runbook inputs")
	}
}

func TestRunbookContractRequiresExplicitOperationAndBounds(t *testing.T) {
	base := job()
	base.Operation = "runbook"
	base.Strategy = "task"
	base.HealthPath = ""
	base.Runbook = &LifecycleHook{Command: []string{"/bin/task"}, TimeoutSeconds: 30}
	if err := validateJob(base); err != nil {
		t.Fatal(err)
	}
	for _, change := range []func(*Job){
		func(j *Job) { j.Operation = "deployment" },
		func(j *Job) { j.Runbook = nil },
		func(j *Job) { j.Strategy = "recreate" },
		func(j *Job) { j.HealthPath = "/" },
		func(j *Job) { j.Runbook = &LifecycleHook{Command: []string{"/bin/task"}, TimeoutSeconds: 121} },
		func(j *Job) { j.Hooks = &LifecycleHooks{PreDeploy: base.Runbook} },
	} {
		invalid := base
		change(&invalid)
		if validateJob(invalid) == nil {
			t.Fatalf("accepted invalid runbook: %+v", invalid)
		}
	}
	agent := &Agent{config: Config{StateDirectory: t.TempDir()}}
	if err := agent.prepareLifecycle(base); err != nil {
		t.Fatal(err)
	}
	if agent.prepareLifecycle(base) == nil {
		t.Fatal("replayed runbook attempt")
	}
	cleanup := base
	cleanup.Mode = "cleanup"
	cleanup.Fence++
	if err := agent.prepareLifecycle(cleanup); err != nil {
		t.Fatal(err)
	}
	if started, err := agent.applicationStarted(cleanup); err != nil || started {
		t.Fatal("runbook cleanup owns application")
	}
	if containerName(hookJob(cleanup, "runbook")) == containerName(base) {
		t.Fatal("task owns application name")
	}
}
