#!/bin/sh
set -eu
/usr/local/bin/dockerd-entrypoint.sh dockerd --host=unix:///var/run/docker.sock --storage-driver=vfs >/tmp/docker.log 2>&1 &
exec /usr/sbin/sshd -D -e -o PasswordAuthentication=no -o PermitRootLogin=prohibit-password -o AllowTcpForwarding=no -o X11Forwarding=no
