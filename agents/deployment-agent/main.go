package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"
)

func run(configPath string) error {
	data, err := os.ReadFile(configPath)
	if err != nil {
		return errors.New("cannot read agent configuration")
	}

	var config Config
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&config) != nil {
		return errors.New("invalid agent configuration")
	}

	if err = validateConfig(config); err != nil {
		return err
	}

	if err = os.MkdirAll(config.StateDirectory, 0700); err != nil {
		return err
	}

	lock, err := os.OpenFile(filepath.Join(config.StateDirectory, "agent.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return err
	}

	defer lock.Close()
	if syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB) != nil {
		return errors.New("another agent owns this state directory")
	}

	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	certificate, err := tls.LoadX509KeyPair(config.Certificate, config.Key)
	if err != nil {
		return errors.New("cannot load agent identity")
	}

	ca, err := os.ReadFile(config.CA)
	if err != nil {
		return errors.New("cannot read gateway CA")
	}

	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(ca) {
		return errors.New("invalid gateway CA")
	}

	client := &http.Client{
		Timeout: 20 * time.Second,
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{
				MinVersion:   tls.VersionTLS13,
				Certificates: []tls.Certificate{certificate},
				RootCAs:      pool,
			},
		},
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}

	defer client.CloseIdleConnections()

	agent := &Agent{
		config: config,
		client: client,
		docker: func(ctx context.Context, input io.Reader, args ...string) ([]byte, error) {
			return dockerCommand(ctx, input, append([]string{"--host", "unix://" + config.DockerSocket}, args...)...)
		},
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	log.Print("Deployment agent polling gateway")
	var pollFailure string
	var pollLogged time.Time
	for ctx.Err() == nil {
		body, err := agent.request(ctx, "poll", struct {
			Capabilities []string `json:"capabilities"`
		}{[]string{"deployment-secrets-v1", "ssh-docker-recreate-v1"}})
		var reply struct {
			Job *Job `json:"job"`
		}

		if err == nil && json.Unmarshal(body, &reply) != nil {
			err = errors.New("invalid poll response")
		}

		switch {
		case ctx.Err() != nil:
		case err != nil:
			// Log a changed failure at once and a persistent one at most once a minute.
			if err.Error() != pollFailure || time.Since(pollLogged) >= time.Minute {
				log.Printf("Gateway poll failed: %v", err)
				pollFailure, pollLogged = err.Error(), time.Now()
			}
		default:
			if pollFailure != "" {
				log.Print("Gateway poll recovered")
				pollFailure = ""
			}

			if reply.Job != nil {
				agent.execute(ctx, *reply.Job)
			}
		}

		select {
		case <-ctx.Done():
			return nil
		case <-time.After(2 * time.Second):
		}
	}

	return nil
}

func main() {
	if len(os.Args) == 6 && os.Args[1] == "--ssh-helper" {
		if err := runSSHHelper(os.Args[2:]); err != nil {
			log.Fatal("SSH helper failed")
		}
		return
	}

	if len(os.Args) != 2 {
		log.Fatal("Usage: deployment-agent /path/to/config.json")
	}

	if err := run(os.Args[1]); err != nil {
		log.Fatal(err)
	}
}
