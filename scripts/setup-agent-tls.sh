#!/bin/sh
set -eu
umask 077
folder=${1:-.data/agent-tls}
if [ -e "$folder" ]; then
  echo 'Destination exists. Choose a new directory to avoid replacing identities.' >&2
  exit 1
fi
mkdir -p "$folder"
openssl req -x509 -newkey rsa:3072 -nodes -keyout "$folder/ca.key" -out "$folder/ca.crt" -days 30 -subj '/CN=Keel local evaluation CA'
for identity in server agent; do
  openssl req -newkey rsa:3072 -nodes -keyout "$folder/$identity.key" -out "$folder/$identity.csr" -subj "/CN=Keel $identity"
  if [ "$identity" = server ]; then
    printf '%s\n' 'subjectAltName=DNS:localhost,IP:127.0.0.1' 'extendedKeyUsage=serverAuth' > "$folder/$identity.ext"
  else
    printf '%s\n' 'extendedKeyUsage=clientAuth' > "$folder/$identity.ext"
  fi
  openssl x509 -req -in "$folder/$identity.csr" -CA "$folder/ca.crt" -CAkey "$folder/ca.key" -CAcreateserial -out "$folder/$identity.crt" -days 30 -extfile "$folder/$identity.ext"
done
openssl x509 -in "$folder/agent.crt" -noout -fingerprint -sha256
