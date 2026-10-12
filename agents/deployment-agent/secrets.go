package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"
)

const (
	secretLimit      = 32
	secretValueLimit = 8192
)

var secretVariable = regexp.MustCompile(`^[A-Z][A-Z0-9_]{0,63}$`)

func (a *Agent) deploymentSecrets(ctx context.Context, j Job) ([]byte, error) {
	if j.SecretCount == 0 {
		return nil, nil
	}

	data, err := a.request(ctx, "secrets", j.Lease)
	if err != nil {
		return nil, errors.New("deployment secrets unavailable")
	}
	defer clear(data)
	return secretEnvironment(data, j.SecretCount)
}

func secretEnvironment(data []byte, count int) ([]byte, error) {
	var response struct {
		Values map[string]string `json:"values"`
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&response) != nil || count < 1 || count > secretLimit || len(response.Values) != count {
		return nil, errors.New("invalid deployment secrets")
	}
	if decoder.Decode(new(any)) != io.EOF {
		return nil, errors.New("invalid deployment secrets")
	}

	names := make([]string, 0, count)
	for name, value := range response.Values {
		if !secretVariable.MatchString(name) || len(value) == 0 || len(value) > secretValueLimit || !utf8.ValidString(value) || strings.ContainsAny(value, "\x00\r\n") {
			return nil, errors.New("invalid deployment secrets")
		}
		names = append(names, name)
	}
	sort.Strings(names)

	var environment bytes.Buffer
	for _, name := range names {
		environment.WriteString(name)
		environment.WriteByte('=')
		environment.WriteString(response.Values[name])
		environment.WriteByte('\n')
	}
	return environment.Bytes(), nil
}
