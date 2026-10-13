package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path/filepath"
	"regexp"
	"strings"
)

type BlueGreenConfig struct {
	BluePort  int `json:"blue_port"`
	GreenPort int `json:"green_port"`
}

type Target struct {
	HookNetwork   string           `json:"hook_network,omitempty"`
	BlueGreen     *BlueGreenConfig `json:"blue_green,omitempty"`
	SSH           *SSHConfig       `json:"ssh,omitempty"`
	HostPort      int              `json:"host_port"`
	ContainerPort int              `json:"container_port"`
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
	Hooks    *LifecycleHooks `json:"hooks,omitempty"`
	Strategy string          `json:"strategy"`
	slot     string
	Lease
	Capability  string `json:"capability"`
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
	Recovery string `json:"recovery,omitempty"`
	Lease
	Outcome string `json:"outcome"`
	Code    string `json:"code"`
}

type Agent struct {
	config Config
	client *http.Client
	// Tests replace this boundary; production always invokes Docker without a shell.
	docker func(context.Context, io.Reader, ...string) ([]byte, error)
	health func(context.Context, int, string) bool
}

var uuidPattern = regexp.MustCompile(`^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`)
var digestPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)
var imagePattern = regexp.MustCompile(`^sha256:[a-f0-9]{64}$`)
var hookNetworkPattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$`)

func validateConfig(c Config) error {
	u, err := url.Parse(c.Gateway)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		return errors.New("gateway must be an HTTPS origin")
	}

	if c.DockerSocket != "" && !filepath.IsAbs(c.DockerSocket) {
		return errors.New("an absolute local Docker socket is required")
	}

	if c.StateDirectory == "" || c.Certificate == "" || c.Key == "" || c.CA == "" || len(c.Targets) == 0 {
		return errors.New("certificate, key, CA, state directory and targets are required")
	}

	ports := map[string]bool{}
	for id, t := range c.Targets {
		if !uuidPattern.MatchString(id) || t.HostPort < 1024 || t.HostPort > 65535 || t.ContainerPort < 1024 || t.ContainerPort > 65535 {
			return errors.New("target IDs and unprivileged, unique host ports are required")
		}

		if t.HookNetwork != "" && !hookNetworkPattern.MatchString(t.HookNetwork) {
			return errors.New("hook network must be a local Docker network name")
		}

		if t.HookNetwork == "host" || t.HookNetwork == "none" {
			return errors.New("hook network cannot use host or none mode")
		}

		host := "local"
		if t.SSH != nil {
			if err := validateSSH(*t.SSH); err != nil {
				return err
			}
			host = t.SSH.Host
		} else if c.DockerSocket == "" {
			return errors.New("local targets require a Docker socket")
		}

		targetPorts := []int{t.HostPort}
		if t.BlueGreen != nil {
			if t.SSH != nil {
				return errors.New("blue/green is supported only on local Docker targets")
			}
			targetPorts = append(targetPorts, t.BlueGreen.BluePort, t.BlueGreen.GreenPort)
		}

		for _, port := range targetPorts {
			key := fmt.Sprintf("%s:%d", host, port)
			if port < 1024 || port > 65535 || ports[key] {
				return errors.New("target host ports must be unprivileged and unique per host")
			}

			ports[key] = true
		}
	}

	return nil
}

func validateJob(j Job) error {
	if j.Capability != "" && j.Capability != "docker-recreate-v1" && j.Capability != "ssh-docker-recreate-v1" && j.Capability != "docker-blue-green-v1" {
		return errors.New("unsupported target capability")
	}

	if !uuidPattern.MatchString(j.AttemptID) || !uuidPattern.MatchString(j.TargetID) || j.Fence < 1 || !digestPattern.MatchString(j.Token) {
		return errors.New("invalid lease")
	}

	if j.Capability == "docker-blue-green-v1" {
		if j.Strategy != "blue-green" {
			return errors.New("blue/green target requires blue/green strategy")
		}
	} else if j.Strategy != "" && j.Strategy != "recreate" {
		return errors.New("target requires recreate strategy")
	}

	if err := validateHooks(j.Hooks); err != nil {
		return err
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
