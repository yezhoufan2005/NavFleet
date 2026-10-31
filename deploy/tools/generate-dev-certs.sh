#!/bin/sh
# Generate a self-signed certificate for the TLS overlay.
#
# FOR A LAB OR A LOCAL TRY-OUT ONLY. Browsers will warn, and a self-signed cert
# gives you encryption without authentication — anything that can intercept the
# connection can present its own certificate just as convincingly. For a real
# deployment use a certificate from your organisation's CA (or Let's Encrypt if
# the host is reachable from the internet) and drop it in as fullchain.pem +
# privkey.pem.
#
# Usage:  sh deploy/tools/generate-dev-certs.sh [host-name-or-IP]
#
# An IP (the usual way to reach a LAN server) goes into the certificate as an IP SAN:
# browsers do not match an address against a DNS name, so 192.168.1.10 written as
# DNS:192.168.1.10 was rejected as a name mismatch.
set -eu

CERT_DIR="$(cd "$(dirname "$0")/.." && pwd)/nginx/certs"
COMMON_NAME="${1:-navfleet.local}"
DAYS=365

mkdir -p "$CERT_DIR"

if [ -f "$CERT_DIR/privkey.pem" ]; then
  echo "refusing to overwrite the existing key at $CERT_DIR/privkey.pem" >&2
  echo "delete it first if you really want a new certificate" >&2
  exit 1
fi

# SANs matter: browsers ignore the legacy CN, so without subjectAltName the cert
# is rejected outright rather than merely untrusted.
if printf '%s' "$COMMON_NAME" |
  grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}$|^[0-9a-fA-F]*:[0-9a-fA-F:]*$'; then
  NAME_SAN="IP:$COMMON_NAME"
else
  NAME_SAN="DNS:$COMMON_NAME"
fi
openssl req -x509 -newkey rsa:2048 -sha256 -days "$DAYS" -nodes \
  -keyout "$CERT_DIR/privkey.pem" \
  -out "$CERT_DIR/fullchain.pem" \
  -subj "/CN=$COMMON_NAME" \
  -addext "subjectAltName=$NAME_SAN,DNS:localhost,IP:127.0.0.1"

# nginx-unprivileged reads the key as uid 101, and a Linux bind mount keeps the host's owner
# and mode, so 600 under the operator's uid was "Permission denied" and a restart loop. Group
# 101 with 640 where the operator may set that group (root, or a member); otherwise 644, which
# for a lab key on this host is the trade-off, said out loud.
if chgrp 101 "$CERT_DIR/privkey.pem" 2>/dev/null; then
  chmod 640 "$CERT_DIR/privkey.pem"
else
  chmod 644 "$CERT_DIR/privkey.pem"
  echo "note: privkey.pem is world-readable so nginx (uid 101) can read it; run as root for 640 / group 101" >&2
fi
chmod 644 "$CERT_DIR/fullchain.pem"

echo "wrote $CERT_DIR/fullchain.pem and privkey.pem ($NAME_SAN, ${DAYS}d)"
echo "start with: docker compose --env-file deploy/.env -f deploy/docker-compose.yml -f deploy/docker-compose.tls.yml up -d"
