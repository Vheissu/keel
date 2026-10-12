#!/bin/sh
set -eu
# A failed describe must not hide a failed create or an unavailable server.
if ! temporal operator namespace describe --namespace keel > /dev/null 2>&1; then
  temporal operator namespace create --namespace keel --retention 30d
fi
