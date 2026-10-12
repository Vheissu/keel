package main

import (
	"context"
	"errors"
	"log"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"time"
)

const (
	// The server renews a 45-second lease on each heartbeat. Transient failures are tolerated
	// until the agent can no longer be sure the lease is still held.
	heartbeatTimeout     = 10 * time.Second
	leaseMargin          = 35 * time.Second
	maxHeartbeatFailures = 3
	// Agent-side aborts (shutdown or a lost lease) are failures with confirmed cleanup. The
	// server records the attempt as cancelled when a cancellation was actually requested.
	abortedCode  = "RECONCILED"
	resultBudget = 15 * time.Second
)

var (
	errCleanupRequested = errors.New("control plane requested cleanup")
	errLeaseLost        = errors.New("lease lost")
	errShutdown         = errors.New("agent shutting down")
	// Tests shorten these waits.
	heartbeatInterval = 10 * time.Second
	retryDelay        = time.Second
)

func (a *Agent) execute(parent context.Context, j Job) {
	if err := validateJob(j); err != nil {
		log.Printf("Rejected invalid job contract: %v", err)
		return
	}

	// The target lock lives in the process temp directory, so it only excludes agents that
	// share that directory (not, for example, services with a private /tmp). The global
	// target fence still rejects older jobs.
	lock, err := os.OpenFile(filepath.Join(os.TempDir(), "keel-target-"+j.TargetID+".lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		log.Printf("Cannot open lock for target %s; attempt %s skipped: %v", j.TargetID, j.AttemptID, err)
		return
	}

	defer lock.Close()
	if syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB) != nil {
		log.Printf("Target %s is locked by another agent process; attempt %s skipped", j.TargetID, j.AttemptID)
		return
	}

	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	action, err := a.heartbeat(parent, j)
	if err != nil {
		log.Printf("Initial heartbeat for attempt %s failed: %v", j.AttemptID, err)
		return
	}

	if action == "cleanup" && j.Mode == "deploy" {
		j.Mode = "cleanup"
	}

	target, allowed := a.config.Targets[j.TargetID]
	if !allowed {
		// Do not confirm cleanup of an unknown target. Leave the lock for reconciliation.
		log.Print("Target is missing from the local allowlist; reconciliation required")
		return
	}

	ctx, cancel := context.WithCancelCause(parent)
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		a.monitorLease(ctx, cancel, j)
	}()
	code := "RECONCILED"
	if j.Mode == "deploy" {
		code = a.deploy(ctx, j, target)
		if code != "HTTP_VERIFIED" && ctx.Err() != nil {
			code = abortCode(ctx)
			cause := context.Cause(ctx)
			if parent.Err() != nil {
				cause = errShutdown
			}

			log.Printf("Attempt %s aborted: %v", j.AttemptID, cause)
		}
	}

	if code != "HTTP_VERIFIED" {
		cleanupContext, stop := context.WithTimeout(context.Background(), 30*time.Second)
		a.progress(cleanupContext, j, "cleaning_up")
		err := a.cleanup(cleanupContext, j)
		stop()
		if err != nil {
			cancel(nil)
			wg.Wait()
			log.Printf("Target cleanup could not be verified (%v); reconciliation required", err)
			return
		}
	}

	result := Result{Lease: j.Lease, Outcome: "failed", Code: code}
	if code == "HTTP_VERIFIED" {
		result.Outcome = "succeeded"
	}

	if code == "CANCELLED" {
		result.Outcome = "cancelled"
	}

	if err := a.deliver(result); err != nil {
		log.Printf("Result for attempt %s was not delivered: %v", j.AttemptID, err)
	}

	cancel(nil)
	wg.Wait()
	log.Printf("Attempt %s finished with %s", j.AttemptID, code)
}

// abortCode maps the reason the attempt context ended to a result code.
func abortCode(ctx context.Context) string {
	if errors.Is(context.Cause(ctx), errCleanupRequested) {
		return "CANCELLED"
	}

	return abortedCode
}

// monitorLease renews the lease until ctx ends. It cancels the attempt only when the
// control plane requests cleanup, rejects the lease, or the lease may have expired.
func (a *Agent) monitorLease(ctx context.Context, cancel context.CancelCauseFunc, j Job) {
	ticker := time.NewTicker(heartbeatInterval)
	defer ticker.Stop()
	renewed := time.Now()
	failures := 0
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}

		beat, stop := context.WithTimeout(ctx, heartbeatTimeout)
		action, err := a.heartbeat(beat, j)
		stop()
		switch {
		case ctx.Err() != nil:
			return
		case err == nil:
			renewed, failures = time.Now(), 0
			if action == "cleanup" && j.Mode != "cleanup" {
				log.Printf("Control plane requested cleanup of attempt %s", j.AttemptID)
				cancel(errCleanupRequested)
				return
			}
		case leaseRejected(err):
			log.Printf("Lease for attempt %s was rejected (%v)", j.AttemptID, err)
			cancel(errLeaseLost)
			return
		default:
			failures++
			if failures >= maxHeartbeatFailures || time.Since(renewed) > leaseMargin {
				log.Printf("Heartbeat for attempt %s failed %d times (%v); lease may expire", j.AttemptID, failures, err)
				cancel(errLeaseLost)
				return
			}

			log.Printf("Heartbeat for attempt %s failed (%v); retrying", j.AttemptID, err)
		}
	}
}

// confirmLease checks the lease before a destructive step, tolerating brief outages.
func (a *Agent) confirmLease(ctx context.Context, j Job) (string, error) {
	var err error
	for tries := 0; tries < maxHeartbeatFailures; tries++ {
		if tries > 0 && !wait(ctx, retryDelay) {
			return "", ctx.Err()
		}

		beat, stop := context.WithTimeout(ctx, heartbeatTimeout)
		var action string
		action, err = a.heartbeat(beat, j)
		stop()
		if err == nil || leaseRejected(err) || ctx.Err() != nil {
			return action, err
		}
	}

	return "", err
}

// A lost response may mean the result committed. Never remove a verified container
// based on a transport error; an expired lease gets a new cleanup-only assignment.
func (a *Agent) deliver(result Result) error {
	// A fresh budget: the result must still be delivered while the agent shuts down.
	ctx, cancel := context.WithTimeout(context.Background(), resultBudget)
	defer cancel()
	var err error
	for tries := 0; tries < 3; tries++ {
		if tries > 0 && !wait(ctx, retryDelay) {
			return err
		}

		attempt, stop := context.WithTimeout(ctx, 5*time.Second)
		_, err = a.request(attempt, "result", result)
		stop()
		if err == nil || rejected(err) {
			return err
		}
	}

	return err
}

// wait pauses for d and reports false if ctx ends first.
func wait(ctx context.Context, d time.Duration) bool {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}
