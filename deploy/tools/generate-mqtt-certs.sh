#!/bin/sh
# Generate a lab CA and a broker server certificate for the MQTT-over-TLS overlay
# (docker-compose.mqtt-tls.yml).
#
# FOR A LAB OR LOCAL TRY-OUT ONLY. A private CA gives you encryption plus the
# ability to verify the broker (the backend trusts ca.crt), which is enough for an
# internal deployment. For anything internet-facing use certificates from your
# organisation's CA and drop them in as ca.crt / server.crt / server.key.
#
# Writes (both gitignored — private keys never belong in the repo):
#   deploy/mosquitto/certs/ca.crt, server.crt, server.key — what the broker mounts
#   deploy/mosquitto/ca/ca.key                             — the CA's signing key
# The CA key is kept out of the mounted directory: whoever holds it can issue a broker
# certificate the backend trusts, so it must not sit in either container. The backend
# mounts ca.crt alone as MQTT_CA_FILE and connects to mqtts://mosquitto:8883.
#
# Usage:  sh deploy/tools/generate-mqtt-certs.sh [extra-host-or-IP ...]
#
# The broker certificate names `mosquitto` (the backend's hop on the `bus` network),
# localhost and 127.0.0.1. Vehicles connecting from outside need the server's own
# address in it too: pass each IP or DNS name they will use, and publish 8883 (see
# deployment.md 9.2.1).
set -eu

DEPLOY_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CERT_DIR="$DEPLOY_DIR/mosquitto/certs"
CA_DIR="$DEPLOY_DIR/mosquitto/ca"
DAYS=825 # under the 825-day cap some TLS stacks enforce on leaf certs

SAN="DNS:mosquitto,DNS:localhost,IP:127.0.0.1"
for name in "$@"; do
  if printf '%s' "$name" |
    grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}$|^[0-9a-fA-F]*:[0-9a-fA-F:]*$'; then
    SAN="$SAN,IP:$name"
  else
    SAN="$SAN,DNS:$name"
  fi
done

mkdir -p "$CERT_DIR" "$CA_DIR"

if [ -f "$CERT_DIR/server.key" ]; then
  echo "refusing to overwrite the existing key at $CERT_DIR/server.key" >&2
  echo "delete the certs in $CERT_DIR first if you really want a new pair" >&2
  exit 1
fi

# 1) A self-signed CA.
openssl req -x509 -newkey rsa:2048 -sha256 -days "$DAYS" -nodes \
  -keyout "$CA_DIR/ca.key" \
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
  -CA "$CERT_DIR/ca.crt" -CAkey "$CA_DIR/ca.key" -CAcreateserial -CAserial "$CA_DIR/ca.srl" \
  -out "$CERT_DIR/server.crt" \
  -extfile /dev/stdin <<EOF
subjectAltName = $SAN
EOF

rm -f "$CERT_DIR/server.csr" "$CA_DIR/ca.srl"

# The CA key is never mounted, so it stays readable by its owner only.
chmod 600 "$CA_DIR/ca.key"
# mosquitto reads the server key as uid 1883, and a Linux bind mount keeps the host's owner and
# mode: 600 under the operator's uid was unreadable to it. Group 1883 with 640 where the operator
# may set that group (root, or a member); otherwise 644, the lab trade-off, said out loud.
if chgrp 1883 "$CERT_DIR/server.key" 2>/dev/null; then
  chmod 640 "$CERT_DIR/server.key"
else
  chmod 644 "$CERT_DIR/server.key"
  echo "note: server.key is world-readable so mosquitto (uid 1883) can read it; run as root for 640 / group 1883" >&2
fi
chmod 644 "$CERT_DIR/ca.crt" "$CERT_DIR/server.crt"

echo "wrote CA + broker cert to $CERT_DIR, CA key to $CA_DIR (SAN $SAN, ${DAYS}d)"
echo "start with: docker compose --env-file deploy/.env -f deploy/docker-compose.yml -f deploy/docker-compose.mqtt-tls.yml up -d"
