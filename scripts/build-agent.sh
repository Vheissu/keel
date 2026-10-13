#!/bin/sh
set -eu
# The agent supports Linux and macOS. Docker supplies the Go toolchain locally.
os=${1:-$(uname -s | tr '[:upper:]' '[:lower:]')}
case "$os" in
  linux|darwin) ;;
  *) echo 'Unsupported target OS' >&2; exit 1 ;;
esac
arch=${2:-$(uname -m)}
output=${3:-deployment-agent}
case "$arch" in
  arm64|aarch64) arch=arm64 ;;
  amd64|x86_64) arch=amd64 ;;
  *) echo 'Unsupported host architecture' >&2; exit 1 ;;
esac
docker run --rm -e GOOS="$os" -e GOARCH="$arch" -v "$PWD:/src" -w /src/agents/deployment-agent golang:1.26-alpine go build -o "$output" .
