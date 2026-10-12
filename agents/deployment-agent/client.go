package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"
)

// The shared client's 20-second timeout suits control messages, not a 25 MiB artifact
// on a slow link. Downloads are bounded by this deadline and the attempt context instead.
const artifactTimeout = 5 * time.Minute

// statusError reports a gateway response, as opposed to a transport failure.
type statusError struct{ status int }

func (e statusError) Error() string { return fmt.Sprintf("gateway status %d", e.status) }

// rejected reports whether the gateway refused the request permanently (4xx).
func rejected(err error) bool {
	var s statusError
	return errors.As(err, &s) && s.status >= 400 && s.status < 500
}

// leaseRejected reports a definitive lease rejection: a revoked agent or a stale lease.
func leaseRejected(err error) bool {
	var s statusError
	return errors.As(err, &s) && (s.status == http.StatusUnauthorized || s.status == http.StatusConflict)
}

func (a *Agent) request(ctx context.Context, path string, input any) ([]byte, error) {
	body, err := json.Marshal(input)
	if err != nil {
		return nil, err
	}

	client := a.client
	limit := int64(4096)
	if path == "artifact" {
		limit = archiveLimit
		download := *a.client
		download.Timeout = 0
		client = &download
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, artifactTimeout)
		defer cancel()
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, a.config.Gateway+"/agent/v1/"+path, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}

	req.Header.Set("Content-Type", "application/json")
	response, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("gateway unavailable: %w", err)
	}

	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, statusError{response.StatusCode}
	}

	data, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil {
		return nil, fmt.Errorf("gateway response interrupted: %w", err)
	}

	if int64(len(data)) > limit {
		return nil, errors.New("gateway response exceeds limit")
	}

	return data, nil
}

func (a *Agent) heartbeat(ctx context.Context, j Job) (string, error) {
	body, err := a.request(ctx, "heartbeat", j.Lease)
	if err != nil {
		return "", err
	}

	var reply struct {
		Action string `json:"action"`
	}

	if json.Unmarshal(body, &reply) != nil || (reply.Action != "continue" && reply.Action != "cleanup") {
		return "", errors.New("invalid heartbeat response")
	}

	return reply.Action, nil
}

func (a *Agent) progress(ctx context.Context, j Job, phase string) {
	// Progress is advisory. Lease heartbeats and result validation remain authoritative.
	_, _ = a.request(ctx, "progress", struct {
		Lease
		Phase string `json:"phase"`
	}{j.Lease, phase})
}
