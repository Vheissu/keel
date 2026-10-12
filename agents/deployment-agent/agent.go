package main

import (
	"context"
	"log"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"time"
)

func (a *Agent) execute(parent context.Context, j Job) {
	if validateJob(j) != nil {
		log.Print("Rejected invalid job contract")
		return
	}

	// A host-wide target lock prevents two processes with different state directories
	// from overlapping Docker effects. A global target fence also rejects older jobs.
	lock, err := os.OpenFile(filepath.Join(os.TempDir(), "keel-target-"+j.TargetID+".lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return
	}

	defer lock.Close()
	if syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB) != nil {
		return
	}

	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	action, err := a.heartbeat(parent, j)
	if err != nil {
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

	ctx, cancel := context.WithCancel(parent)
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		ticker := time.NewTicker(10 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				action, err := a.heartbeat(ctx, j)
				if err != nil || (action == "cleanup" && j.Mode != "cleanup") {
					cancel()
					return
				}
			}
		}
	}()
	code := "RECONCILED"
	if j.Mode == "deploy" {
		code = a.deploy(ctx, j, target)
	}

	if code != "HTTP_VERIFIED" {
		cleanupContext, stop := context.WithTimeout(context.Background(), 30*time.Second)
		err := a.cleanup(cleanupContext, j)
		stop()
		if err != nil {
			cancel()
			wg.Wait()
			log.Print("Target cleanup could not be verified; reconciliation required")
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

	// A lost response may mean the result committed. Never remove a verified container
	// based on a transport error; an expired lease gets a new cleanup-only assignment.
	for tries := 0; tries < 3; tries++ {
		resultContext, stop := context.WithTimeout(context.Background(), 5*time.Second)
		_, err := a.request(resultContext, "result", result)
		stop()
		if err == nil {
			break
		}

		time.Sleep(time.Second)
	}

	cancel()
	wg.Wait()
	log.Printf("Attempt %s finished with %s", j.AttemptID, code)
}
