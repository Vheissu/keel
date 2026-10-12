package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
)

func (a *Agent) request(ctx context.Context, path string, input any) ([]byte, error) {
	body, err := json.Marshal(input)
	if err != nil {
		return nil, err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, a.config.Gateway+"/agent/v1/"+path, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}

	req.Header.Set("Content-Type", "application/json")
	response, err := a.client.Do(req)
	if err != nil {
		return nil, errors.New("gateway unavailable")
	}

	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("gateway status %d", response.StatusCode)
	}

	limit := int64(4096)
	if path == "artifact" {
		limit = 25 * 1024 * 1024
	}

	data, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil || int64(len(data)) > limit {
		return nil, errors.New("invalid gateway response")
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
