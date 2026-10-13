package main

import (
	"context"
	"errors"
	"regexp"
	"strings"
	"unicode/utf8"
)

var runbookInputName = regexp.MustCompile(`^[A-Z][A-Z0-9_]{0,47}$`)

func validateRunbookInputs(j Job) error {
	if len(j.RunbookInputs) > 0 && j.Runbook == nil {
		return errors.New("runbook inputs require a task")
	}
	if len(j.RunbookInputs) > 16 {
		return errors.New("too many runbook inputs")
	}

	for name, value := range j.RunbookInputs {
		if !runbookInputName.MatchString(name) || len(value) > 1024 || utf8.RuneCountInString(value) > 256 || !utf8.ValidString(value) || strings.ContainsFunc(value, func(c rune) bool { return c < 32 || c == 127 }) {
			return errors.New("invalid runbook input")
		}
		for _, secret := range j.Runbook.Secrets {
			if secret == "KEEL_INPUT_"+name {
				return errors.New("runbook input conflicts with secret")
			}
		}
	}

	return nil
}

// A runbook owns only its bounded task container. It never creates, stops or
// verifies the application's container and never switches a blue/green route.
func (a *Agent) runRunbook(ctx context.Context, j Job, t Target) string {
	if code := a.loadArtifact(ctx, j); code != "" {
		return code
	}

	secrets, err := a.deploymentSecrets(ctx, j)
	if err != nil {
		return "SECRET_UNAVAILABLE"
	}
	defer clear(secrets)

	if j.Runbook.Network == "target" && t.HookNetwork == "" {
		return "HOOK_NETWORK_UNAVAILABLE"
	}

	if code := a.runHook(ctx, j, t, "runbook", j.Runbook, secrets); code != "" {
		return code
	}

	return "RUNBOOK_SUCCEEDED"
}
