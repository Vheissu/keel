#!/bin/sh
set -eu
export POSTGRES_PWD=$(cat /run/secrets/temporal_password)
exec /etc/temporal/entrypoint.sh
