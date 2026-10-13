package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestPollAcceptsBoundedInputsButRejectsOversizedResponses(t *testing.T) {
	payload, err := json.Marshal(map[string]any{"job": map[string]any{"runbook_inputs": map[string]string{
		"ONE": strings.Repeat("界", 256), "TWO": strings.Repeat("界", 256),
		"THREE": strings.Repeat("界", 256), "FOUR": strings.Repeat("界", 256),
		"FIVE": strings.Repeat("界", 256), "SIX": strings.Repeat("界", 256),
	}}})
	if err != nil || len(payload) <= 4096 {
		t.Fatal("fixture must exceed the old response limit")
	}

	agent, _ := fakeGateway(t, func(w http.ResponseWriter, _ *http.Request, _ string, call int) {
		if call == 1 {
			_, _ = w.Write(payload)
		} else {
			_, _ = io.WriteString(w, strings.Repeat("x", 65537))
		}
	})

	data, err := agent.request(context.Background(), "poll", struct{}{})
	if err != nil || string(data) != string(payload) {
		t.Fatal("valid bounded input response was rejected")
	}
	if _, err := agent.request(context.Background(), "poll", struct{}{}); err == nil {
		t.Fatal("oversized poll response accepted")
	}
}
