#!/bin/sh
# Generate a lab CA and a broker server certificate for the MQTT-over-TLS overlay
# (docker-compose.mqtt-tls.yml).
#
# FOR A LAB OR LOCAL TRY-OUT ONLY. A private CA gives you encryption plus the
# ability to verify the broker (the backend trusts ca.crt), which is enough for an
# internal deployment. For anything internet-facing use certificates from your
# organisation's CA and drop them in as ca.crt / server.crt / server.key.
#
# Writes into deploy/mosquitto/certs/ (gitignored — private keys never belong in
# the repo):
#   ca.crt / ca.key      — the lab CA
#   server.crt / server.key — the broker cert, signed by the CA
# The backend mounts ca.crt as MQTT_CA_FILE and connects to mqtts://mosquitto:8883.
#
# Usage:  sh deploy/tools/generate-mqtt-certs.sh
set -eu

CERT_DIR="$(cd "$(dirname "$0")/.." && pwd)/mosquitto/certs"
DAYS=825 # under the 825-day cap some TLS stacks enforce on leaf certs

mkdir -p "$CERT_DIR"

if [ -f "$CERT_DIR/server.key" ]; then
  echo "refusing to overwrite the existing key at $CERT_DIR/server.key" >&2
  echo "delete the certs in $CERT_DIR first if you really want a new pair" >&2
  exit 1
fi

# 1) A self-signed CA.
openssl req -x509 -newkey rsa:2048 -sha256 -days "$DAYS" -nodes \
  -keyout "$CERT_DIR/ca.key" \
  -out "$CERT_DIR/ca.crt" \
  -subj "/CN=NavFleet lab MQTT CA"

# 2) A server key + CSR for the broker.
openssl req -newkey rsa:2048 -sha256 -nodes \
  -keyout "$CERT_DIR/server.key" \
  -out "$CERT_DIR/server.csr" \
  -subj "/CN=mosquitto"

# 3) Sign it with the CA. The SAN must list `mosquitto` — that is the hostname the
#    backend connects to on the `bus` network, and TLS verification checks the SAN,
#    not the CN. localhost / 127.0.0.1 are added for a host-side `openssl s_client`.
openssl x509 -req -sha256 -days "$DAYS" \
  -in "$CERT_DIR/server.csr" \
  -CA "$CERT_DIR/ca.crt" -CAkey "$CERT_DIR/ca.key" -CAcreateserial \
  -out "$CERT_DIR/server.crt" \
  -extfile /dev/stdin <<'EOF'
subjectAltName = DNS:mosquitto,DNS:localhost,IP:127.0.0.1
EOF

rm -f "$CERT_DIR/server.csr" "$CERT_DIR/ca.srl"

# mosquitto drops to uid 1883 and reads these; the key must not be world-readable.
chmod 600 "$CERT_DIR/ca.key" "$CERT_DIR/server.key"
chmod 644 "$CERT_DIR/ca.crt" "$CERT_DIR/server.crt"

echo "wrote CA + broker cert to $CERT_DIR (CN=mosquitto, SAN mosquitto/localhost, ${DAYS}d)"
echo "start with: docker compose --env-file deploy/.env -f deploy/docker-compose.yml -f deploy/docker-compose.mqtt-tls.yml up -d"
