#!/usr/bin/env bash
# État de santé du socle. --wait : attend (10 min max) que tout soit sain.
# Code retour 0 si tout est sain, 1 sinon.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT" || exit 1
ENGINE="${ENGINE:-podman}"
SERVICES=(postgres valkey etcd apisix keycloak seaweedfs clamav simulateur rabbitmq backend connector-cockpit sim-cockpit portail console)
WAIT=false; [[ "${1:-}" == "--wait" ]] && WAIT=true
DEADLINE=$(( $(date +%s) + 600 ))

status_of() {
  local id
  id=$($ENGINE ps -q --filter "label=com.docker.compose.service=$1" --filter "label=com.docker.compose.project=api-platform" | head -1)
  [[ -z "$id" ]] && { echo "absent"; return; }
  $ENGINE inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id"
}

while true; do
  all_ok=true
  report=""
  for s in "${SERVICES[@]}"; do
    st=$(status_of "$s")
    [[ "$st" != "healthy" ]] && all_ok=false
    report+=$(printf '  %-11s %s\n' "$s" "$st")$'\n'
  done
  if $all_ok || ! $WAIT || (( $(date +%s) > DEADLINE )); then break; fi
  sleep 10
done

echo "Services :"
printf '%s' "$report"

# Vue du back-end sur ses dépendances (base, Valkey, API d'administration d'APISIX).
id=$($ENGINE ps -q --filter "label=com.docker.compose.service=backend" --filter "label=com.docker.compose.project=api-platform" | head -1)
if [[ -n "$id" ]]; then
  echo "Back-end /health/ready :"
  $ENGINE exec "$id" node -e "fetch('http://127.0.0.1:3000/health/ready').then(r=>r.text()).then(t=>console.log('  '+t)).catch(e=>console.log('  injoignable : '+e.message))"
fi

if $all_ok; then echo "OK : socle sain."; exit 0; else echo "KO : au moins un service n'est pas sain."; exit 1; fi
