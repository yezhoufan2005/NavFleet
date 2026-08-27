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
# Usage:  sh deploy/tools/generate-dev-certs.sh [common-name]
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
openssl req -x509 -newkey rsa:2048 -sha256 -days "$DAYS" -nodes \
  -keyout "$CERT_DIR/privkey.pem" \
  -out "$CERT_DIR/fullchain.pem" \
  -subj "/CN=$COMMON_NAME" \
  -addext "subjectAltName=DNS:$COMMON_NAME,DNS:localhost,IP:127.0.0.1"

chmod 600 "$CERT_DIR/privkey.pem"
chmod 644 "$CERT_DIR/fullchain.pem"

echo "wrote $CERT_DIR/fullchain.pem and privkey.pem (CN=$COMMON_NAME, ${DAYS}d)"
echo "start with: docker compose --env-file deploy/.env -f deploy/docker-compose.yml -f deploy/docker-compose.tls.yml up -d"
