package main

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/url"
	"path/filepath"
	"regexp"
	"strings"
)

type Target struct {
	HostPort      int `json:"host_port"`
	ContainerPort int `json:"container_port"`
}

type Config struct {
	Gateway        string            `json:"gateway"`
	Certificate    string            `json:"certificate"`
	Key            string            `json:"key"`
	CA             string            `json:"ca"`
	StateDirectory string            `json:"state_directory"`
	DockerSocket   string            `json:"docker_socket"`
	Targets        map[string]Target `json:"targets"`
}

type Lease struct {
	AttemptID string `json:"attempt_id"`
	Fence     int    `json:"fence"`
	Token     string `json:"token"`
}

type Job struct {
	Lease
	Mode        string `json:"mode"`
	TargetID    string `json:"target_id"`
	Digest      string `json:"digest"`
	Size        int64  `json:"size"`
	ImageID     string `json:"image_id"`
	HealthPath  string `json:"health_path"`
	ArchivePath string `json:"archive_path"`
	SecretCount int    `json:"secret_count"`
}

type Result struct {
	Lease
	Outcome string `json:"outcome"`
	Code    string `json:"code"`
}

type Agent struct {
	config Config
	client *http.Client
	// Tests replace this boundary; production always invokes Docker without a shell.
	docker func(context.Context, io.Reader, ...string) ([]byte, error)
}

var uuidPattern = regexp.MustCompile(`^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`)
var digestPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)
var imagePattern = regexp.MustCompile(`^sha256:[a-f0-9]{64}$`)

func validateConfig(c Config) error {
	u, err := url.Parse(c.Gateway)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		return errors.New("gateway must be an HTTPS origin")
	}

	if !filepath.IsAbs(c.DockerSocket) {
		return errors.New("an absolute local Docker socket is required")
	}

	if c.StateDirectory == "" || c.Certificate == "" || c.Key == "" || c.CA == "" || len(c.Targets) == 0 {
		return errors.New("certificate, key, CA, state directory and targets are required")
	}

	ports := map[int]bool{}
	for id, t := range c.Targets {
		if !uuidPattern.MatchString(id) || t.HostPort < 1024 || t.HostPort > 65535 || t.ContainerPort < 1024 || t.ContainerPort > 65535 || ports[t.HostPort] {
			return errors.New("target IDs and unprivileged, unique host ports are required")
		}

		ports[t.HostPort] = true
	}

	return nil
}

func validateJob(j Job) error {
	if !uuidPattern.MatchString(j.AttemptID) || !uuidPattern.MatchString(j.TargetID) || j.Fence < 1 || !digestPattern.MatchString(j.Token) {
		return errors.New("invalid lease")
	}

	if j.Mode == "cleanup" {
		return nil
	}

	if j.Mode != "deploy" || !digestPattern.MatchString(j.Digest) || !imagePattern.MatchString(j.ImageID) || j.Size < 1 || j.Size > archiveLimit || j.SecretCount < 0 || j.SecretCount > secretLimit {
		return errors.New("invalid artifact contract")
	}

	if j.ArchivePath != "" && !validArchivePath(j.ArchivePath) {
		return errors.New("invalid archive path")
	}

	u, err := url.Parse(j.HealthPath)
	if err != nil || !strings.HasPrefix(j.HealthPath, "/") || strings.HasPrefix(j.HealthPath, "//") || u.Host != "" || u.Scheme != "" || u.Fragment != "" || len(j.HealthPath) > 200 {
		return errors.New("invalid health path")
	}

	return nil
}
