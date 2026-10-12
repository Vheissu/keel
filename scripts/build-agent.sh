#!/bin/sh
set -eu
# The agent supports Linux and macOS. Docker supplies the Go toolchain locally.
os=$(uname -s | tr '[:upper:]' '[:lower:]')
arch=$(uname -m)
case "$arch" in
  arm64|aarch64) arch=arm64 ;;
  x86_64) arch=amd64 ;;
  *) echo 'Unsupported host architecture' >&2; exit 1 ;;
esac
docker run --rm -e GOOS="$os" -e GOARCH="$arch" -v "$PWD:/src" -w /src/agents/deployment-agent golang:1.26-alpine go build -o deployment-agent .
