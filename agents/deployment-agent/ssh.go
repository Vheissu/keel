package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// All connection details are operator-controlled local configuration, never job data.
type SSHConfig struct {
	Host           string `json:"host"`
	Port           int    `json:"port"`
	User           string `json:"user"`
	IdentityFile   string `json:"identity_file"`
	KnownHostsFile string `json:"known_hosts_file"`
	HelperPath     string `json:"helper_path"`
	StateDirectory string `json:"state_directory"`
}

var sshHostPattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9.-]*$`)
var sshUserPattern = regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_-]*$`)
var sshPathPattern = regexp.MustCompile(`^/[a-zA-Z0-9_./-]+$`)

func validateSSH(c SSHConfig) error {
	validHost := sshHostPattern.MatchString(c.Host) || net.ParseIP(c.Host) != nil
	if !validHost || !sshUserPattern.MatchString(c.User) || c.Port < 1 || c.Port > 65535 {
		return errors.New("SSH requires a host, user and port")
	}
	for _, path := range []string{c.IdentityFile, c.KnownHostsFile, c.HelperPath, c.StateDirectory} {
		// Also excludes OpenSSH percent tokens, environment expansion and remote shell syntax.
		if !validSSHPath(path) {
			return errors.New("SSH paths must be absolute, clean paths without spaces or shell syntax")
		}
	}
	return nil
}

func validSSHPath(path string) bool {
	return sshPathPattern.MatchString(path) && filepath.Clean(path) == path && path != "/"
}

func sshArguments(c SSHConfig, j Job) []string {
	return []string{
		"-F", "/dev/null", "-T", "-p", strconv.Itoa(c.Port), "-l", c.User,
		"-i", c.IdentityFile,
		"-o", "UserKnownHostsFile=" + c.KnownHostsFile,
		"-o", "GlobalKnownHostsFile=/dev/null",
		"-o", "StrictHostKeyChecking=yes",
		"-o", "BatchMode=yes",
		"-o", "IdentitiesOnly=yes",
		"-o", "IdentityAgent=none",
		"-o", "ForwardAgent=no",
		"-o", "ClearAllForwardings=yes",
		"-o", "ConnectTimeout=10",
		"-o", "ServerAliveInterval=5",
		"-o", "ServerAliveCountMax=2",
		"-o", "LogLevel=ERROR",
		c.Host, c.HelperPath, "--ssh-helper", c.StateDirectory, j.TargetID, strconv.Itoa(j.Fence), "v1",
	}
}

var errRemoteOperation = errors.New("remote operation failed")

type remoteRequest struct {
	Operation string   `json:"operation"`
	Args      []string `json:"args,omitempty"`
	Input     []byte   `json:"input,omitempty"`
	Port      int      `json:"port,omitempty"`
	Path      string   `json:"path,omitempty"`
}

type remoteReply struct {
	OK     bool   `json:"ok"`
	Output []byte `json:"output,omitempty"`
}

type sshTransport struct {
	config  SSHConfig
	job     Job
	command *exec.Cmd
	input   io.WriteCloser
	output  *bufio.Scanner
	ready   bool
}

func (s *sshTransport) close() {
	if s.command != nil {
		_ = s.input.Close()
		_ = s.command.Process.Kill()
		_ = s.command.Wait()
		s.command = nil
	}
}

func (s *sshTransport) exchange(ctx context.Context, request remoteRequest) ([]byte, error) {
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}

	ctx, cancel := context.WithTimeout(ctx, 40*time.Second)
	defer cancel()
	if s.command == nil {
		command := exec.Command("ssh", sshArguments(s.config, s.job)...)
		input, err := command.StdinPipe()
		if err != nil {
			return nil, errors.New("SSH unavailable")
		}
		output, err := command.StdoutPipe()
		if err != nil {
			_ = input.Close()
			return nil, errors.New("SSH unavailable")
		}
		// SSH diagnostics may contain local paths or addresses; never publish them.
		command.Stderr = io.Discard
		if command.Start() != nil {
			_ = input.Close()
			return nil, errors.New("SSH unavailable")
		}
		scanner := bufio.NewScanner(output)
		scanner.Buffer(make([]byte, 4096), 128*1024)
		s.command, s.input, s.output = command, input, scanner
		s.ready = false
	}
	type result struct {
		output []byte
		err    error
	}
	done := make(chan result, 1)
	go func() {
		output, err := s.exchangeBlocking(request)
		done <- result{output, err}
	}()
	select {
	case reply := <-done:
		if reply.err != nil && !errors.Is(reply.err, errRemoteOperation) {
			s.close()
		}
		return reply.output, reply.err
	case <-ctx.Done():
		// Killing SSH closes the remote input. Its helper holds the remote lock until
		// any in-flight Docker operation is reaped; cleanup must acquire that lock.
		s.close()
		<-done
		return nil, errors.New("SSH operation interrupted")
	}
}

func (s *sshTransport) readReply(reply *remoteReply) error {
	if !s.output.Scan() {
		return errors.New("missing or oversized SSH response")
	}

	return json.Unmarshal(s.output.Bytes(), reply)
}

func (s *sshTransport) exchangeBlocking(request remoteRequest) ([]byte, error) {
	if !s.ready {
		var ready remoteReply
		if s.readReply(&ready) != nil || !ready.OK {
			return nil, errors.New("SSH connection or target handshake failed")
		}
		s.ready = true
	}
	if json.NewEncoder(s.input).Encode(request) != nil {
		return nil, errors.New("SSH write failed")
	}
	var reply remoteReply
	if s.readReply(&reply) != nil {
		return nil, errors.New("SSH response failed")
	}
	if !reply.OK {
		return nil, errRemoteOperation
	}
	return reply.Output, nil
}

func (s *sshTransport) docker(ctx context.Context, input io.Reader, args ...string) ([]byte, error) {
	var data []byte
	var err error
	if input != nil {
		data, err = io.ReadAll(io.LimitReader(input, archiveLimit+1))
		if err != nil || len(data) > archiveLimit {
			return nil, errors.New("SSH input exceeds limit")
		}
		defer clear(data)
	}
	return s.exchange(ctx, remoteRequest{Operation: "docker", Args: args, Input: data})
}

func (s *sshTransport) health(ctx context.Context, port int, path string) bool {
	_, err := s.exchange(ctx, remoteRequest{Operation: "health", Port: port, Path: path})
	return err == nil
}

// lockRemoteTarget retains a durable high-water mark while serialising the complete session.
// Never delete these files: a new inode would bypass an existing process's flock.
func lockRemoteTarget(directory, target string, fence int) (*os.File, error) {
	if err := os.MkdirAll(directory, 0700); err != nil {
		return nil, err
	}
	lock, err := os.OpenFile(filepath.Join(directory, target+".lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	fail := func(err error) (*os.File, error) {
		_ = lock.Close()
		return nil, err
	}
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return fail(err)
	}
	path := filepath.Join(directory, target+".fence")
	data, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		return fail(err)
	}
	if err == nil {
		previous, parseErr := strconv.Atoi(string(data))
		if parseErr != nil || previous < 1 || previous > fence {
			return fail(errors.New("invalid or stale fence"))
		}
	}
	file, err := os.OpenFile(path+".next", os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
	if err != nil {
		return fail(err)
	}
	_, err = fmt.Fprint(file, fence)
	if err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Rename(path+".next", path)
	}
	if err != nil {
		return fail(err)
	}
	dir, err := os.Open(directory)
	if err != nil {
		return fail(err)
	}
	err = dir.Sync()
	_ = dir.Close()
	if err != nil {
		return fail(err)
	}
	return lock, nil
}

func runSSHHelper(args []string) error {
	if len(args) != 4 {
		return errors.New("invalid helper arguments")
	}

	fence, err := strconv.Atoi(args[2])
	if err != nil || fence < 1 || !uuidPattern.MatchString(args[1]) || !validSSHPath(args[0]) || args[3] != "v1" {
		return errors.New("invalid helper arguments")
	}
	lock, err := lockRemoteTarget(args[0], args[1], fence)
	if err != nil {
		return err
	}
	defer lock.Close()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM, syscall.SIGHUP)
	defer stop()
	ctx, cancel := context.WithTimeout(ctx, 11*time.Minute)
	defer cancel()
	encoder := json.NewEncoder(os.Stdout)
	if err := encoder.Encode(remoteReply{OK: true}); err != nil {
		return err
	}

	requests := make(chan remoteRequest)
	go func() {
		defer close(requests)
		scanner := bufio.NewScanner(os.Stdin)
		scanner.Buffer(make([]byte, 4096), int(archiveLimit)*2)
		for scanner.Scan() {
			var request remoteRequest
			if json.Unmarshal(scanner.Bytes(), &request) != nil {
				return
			}
			select {
			case requests <- request:
			case <-ctx.Done():
				return
			}
		}
	}()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case request, ok := <-requests:
			if !ok {
				return nil
			}
			var output []byte
			var operationErr error
			switch request.Operation {
			case "docker":
				// The helper is a Docker deployment transport, not a shell executor.
				if len(request.Args) < 2 || (request.Args[0] != "image" && request.Args[0] != "container") || len(request.Input) > archiveLimit {
					return errors.New("invalid Docker request")
				}
				output, operationErr = dockerCommandWithLock(ctx, bytes.NewReader(request.Input), lock, append([]string{"--host", "unix:///var/run/docker.sock"}, request.Args...)...)
			case "health":
				if request.Port < 1024 || request.Port > 65535 || !strings.HasPrefix(request.Path, "/") || strings.HasPrefix(request.Path, "//") || len(request.Path) > 200 || !localHealth(ctx, request.Port, request.Path) {
					operationErr = errors.New("health verification failed")
				}
			default:
				return errors.New("unsupported operation")
			}
			clear(request.Input)
			if err := encoder.Encode(remoteReply{OK: operationErr == nil, Output: output}); err != nil {
				return err
			}
		}
	}
}
