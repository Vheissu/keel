package main

import (
	"bufio"
	"context"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func sshConfig() SSHConfig {
	return SSHConfig{
		Host:           "deploy.internal",
		Port:           22,
		User:           "keel",
		IdentityFile:   "/etc/keel/id_ed25519",
		KnownHostsFile: "/etc/keel/known_hosts",
		HelperPath:     "/usr/local/bin/keel-agent",
		StateDirectory: "/var/lib/keel",
	}
}

func TestSSHConfigRejectsExpansionAndShellInput(t *testing.T) {
	for _, bad := range []string{"/tmp/key file", "/tmp/%h", "/tmp/${HOME}", "/tmp/../key", "/tmp/key;touch", "/tmp/$(id)", "/"} {
		c := sshConfig()
		c.IdentityFile = bad
		if validateSSH(c) == nil {
			t.Fatalf("accepted %q", bad)
		}
	}
	for _, bad := range []string{"-oProxyCommand=id", "host;id", "host\nother", "user@host", "$(id)"} {
		c := sshConfig()
		c.Host = bad
		if validateSSH(c) == nil {
			t.Fatalf("accepted host %q", bad)
		}
	}
	if validateSSH(sshConfig()) != nil {
		t.Fatal("valid SSH configuration rejected")
	}
	args := strings.Join(sshArguments(sshConfig(), job()), " ")
	for _, option := range []string{"StrictHostKeyChecking=yes", "IdentityAgent=none", "ForwardAgent=no", "-F /dev/null", "BatchMode=yes"} {
		if !strings.Contains(args, option) {
			t.Fatalf("missing %s", option)
		}
	}
}

func TestRemoteLockAndDurableFence(t *testing.T) {
	dir, target := t.TempDir(), job().TargetID
	lock, err := lockRemoteTarget(dir, target, 2)
	if err != nil {
		t.Fatal(err)
	}
	if other, err := lockRemoteTarget(dir, target, 3); err == nil {
		other.Close()
		t.Fatal("concurrent session acquired lock")
	}
	lock.Close()
	if stale, err := lockRemoteTarget(dir, target, 1); err == nil {
		stale.Close()
		t.Fatal("stale fence accepted")
	}
	lock, err = lockRemoteTarget(dir, target, 2)
	if err != nil {
		t.Fatal("same-fence cleanup rejected", err)
	}
	lock.Close()
	lock, err = lockRemoteTarget(dir, target, 3)
	if err != nil {
		t.Fatal(err)
	}
	lock.Close()
	if err := os.WriteFile(filepath.Join(dir, target+".fence"), []byte("corrupt"), 0600); err != nil {
		t.Fatal(err)
	}
	if unsafe, err := lockRemoteTarget(dir, target, 4); err == nil {
		unsafe.Close()
		t.Fatal("corrupt fence accepted")
	}
}

func TestTransportMismatchNeverTouchesDockerOrCompletes(t *testing.T) {
	a, calls := fakeGateway(t, func(w http.ResponseWriter, _ *http.Request, _ string, _ int) {
		io.WriteString(w, `{"action":"continue"}`)
	})
	a.docker = func(context.Context, io.Reader, ...string) ([]byte, error) {
		t.Fatal("Docker called on wrong host")
		return nil, nil
	}
	j := job()
	j.Capability = "ssh-docker-recreate-v1"
	a.execute(context.Background(), j)
	if calls("result") != 0 {
		t.Fatal("mismatched host confirmed cleanup")
	}
}

func TestSSHReplyLimit(t *testing.T) {
	scanner := bufio.NewScanner(strings.NewReader(strings.Repeat("x", 128*1024)))
	scanner.Buffer(make([]byte, 4096), 128*1024)
	remote := sshTransport{output: scanner}
	if remote.readReply(&remoteReply{}) == nil {
		t.Fatal("oversized response accepted")
	}
}

func TestSSHInterruptedRequestClosesTransport(t *testing.T) {
	dir := t.TempDir()
	script := "#!/bin/sh\nprintf '{\"ok\":true}\\n'\nread -r request\nexec /bin/sleep 30\n"
	if err := os.WriteFile(filepath.Join(dir, "ssh"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)

	remote := sshTransport{config: sshConfig(), job: job()}
	defer remote.close()
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	started := time.Now()
	if _, err := remote.exchange(ctx, remoteRequest{Operation: "health", Port: 18080, Path: "/"}); err == nil {
		t.Fatal("interrupted operation succeeded")
	}
	if ctx.Err() == nil || time.Since(started) > time.Second || remote.command != nil {
		t.Fatal("interrupted SSH process was not reaped promptly")
	}
}

func TestDockerChildRetainsRemoteLock(t *testing.T) {
	// Run the lock owner in a separate process so SIGKILL models a helper crash,
	// rather than closing an exec.Cmd file descriptor concurrently in this test.
	if dir := os.Getenv("KEEL_SSH_TEST_CHILD_DIR"); dir != "" {
		lock, err := lockRemoteTarget(dir, job().TargetID, 1)
		if err != nil {
			t.Fatal(err)
		}
		defer lock.Close()

		if _, err := dockerCommandWithLock(context.Background(), nil, lock, "image", "load"); err != nil {
			t.Fatal(err)
		}
		return
	}

	dir := t.TempDir()
	marker := filepath.Join(dir, "started")
	script := "#!/bin/sh\nprintf ready > \"$KEEL_SSH_TEST_MARKER\"\nexec /bin/sleep 2\n"
	if err := os.WriteFile(filepath.Join(dir, "docker"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)
	t.Setenv("KEEL_SSH_TEST_MARKER", marker)

	command := exec.Command(os.Args[0], "-test.run=^TestDockerChildRetainsRemoteLock$")
	command.Env = append(os.Environ(), "KEEL_SSH_TEST_CHILD_DIR="+dir)
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	defer command.Process.Kill()

	deadline := time.Now().Add(time.Second)
	for {
		if _, err := os.Stat(marker); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("Docker child did not start")
		}
		time.Sleep(time.Millisecond)
	}

	_ = command.Process.Kill()
	_ = command.Wait()
	if other, err := lockRemoteTarget(dir, job().TargetID, 2); err == nil {
		other.Close()
		t.Fatal("target unlocked while its Docker child was still running")
	}

	deadline = time.Now().Add(3 * time.Second)
	for {
		other, err := lockRemoteTarget(dir, job().TargetID, 2)
		if err == nil {
			other.Close()
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("lock was not released after Docker exited", err)
		}
		time.Sleep(10 * time.Millisecond)
	}
}
