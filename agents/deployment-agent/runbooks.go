package main

import "context"

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
