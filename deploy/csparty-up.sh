#!/bin/bash
# CS Party on game-host (ISSUE). Recreates both containers from the built images.
# Unraid has no docker compose, so this stands in for deploy/docker-compose.yml with our ports:
# HLDS on UDP 27016 (27015 is nvmp-coop), relay on TCP 8095 (8080 is sabnzbd). SWAG proxies
# csparty.example.com -> HOST_IP:8095.
#
#   ./csparty-up.sh            recreate server + relay
#   ./csparty-up.sh relay      recreate only the relay
set -euo pipefail
D=/srv/cs-party
. "$D/.env"   # PARTY_KEY, RCON_PASSWORD, LOBBY_SECRET (same value as the lobby Worker's secret, ISSUE)

up_server() {
  docker rm -f cs-party-server >/dev/null 2>&1 || true
  docker run -d --name cs-party-server --network host --restart unless-stopped --log-driver json-file --log-opt max-size=50m --log-opt max-file=1 --cpu-shares 4096 \
    -e MAP=de_dust2 -e PORT=27016 -e SV_LAN=1 -e MAXPLAYERS=10 -e RCON_PASSWORD="$RCON_PASSWORD" \
    --health-cmd 'bash -c "exec 3<>/dev/udp/127.0.0.1/27016; printf \"\xff\xff\xff\xffTSource Engine Query\x00\" >&3; timeout 3 head -c 5 <&3 | grep -qa ."' \
    --health-interval 30s --health-timeout 8s --health-start-period 60s --health-retries 3 \
    cs-party-server:0.5.30-vq
}

# MAX_PER_IP: the relay's default of 6 refused the 7th player from one household (everyone shares the public IP).
# LOBBY_SECRET + RELAY_ID: also accept the lobby Worker's per-lobby keys; RELAY_ID is this server's id in its POOL.
up_relay() {
  docker rm -f cs-party-relay >/dev/null 2>&1 || true
  docker run -d --name cs-party-relay --network host --restart unless-stopped --log-driver json-file --log-opt max-size=50m --log-opt max-file=1 \
    -e PORT=8095 -e GAME=127.0.0.1:27016 -e TRUST_PROXY=1 -e PARTY_KEY="$PARTY_KEY" -e MAX_PER_IP=12 \
    -e LOBBY_SECRET="${LOBBY_SECRET:-}" -e RELAY_ID=raid1 \
    -v "$D/gamedata.zip:/app/public/gamedata.zip:ro" \
    -v "$D/mappacks:/app/public/mappacks:ro" \
    --health-cmd "node -e \"fetch('http://127.0.0.1:8095/healthz').then((r) => process.exit(r.ok ? 0 : 1), => process.exit(1))\"" \
    --health-interval 30s --health-timeout 5s --health-retries 3 \
    cs-party-relay:0.4.32
}

case "${1:-all}" in
  server) up_server ;;
  relay)  up_relay ;;
  all)    up_server; up_relay ;;
  *) echo "usage: $0 [all|server|relay]" >&2; exit 2 ;;
esac
