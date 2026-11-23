#!/usr/bin/env bash
# Premier démarrage : génère .env (secrets aléatoires), construit les images, démarre le socle
# et attend que tous les services soient sains.
#   deploy/scripts/init.sh          socle seul
#   deploy/scripts/init.sh --dev    + ports exposés en local (poste développeur, nécessaire pour qa-lot1.sh)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
COMPOSE="${COMPOSE:-podman compose}"
FILES=(-f deploy/compose.yaml)
[[ "${1:-}" == "--dev" ]] && FILES+=(-f deploy/compose.dev.yaml)

secret() { openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c "${1:-32}"; }

if [[ ! -f .env ]]; then
  echo "Génération de .env…"
  cp .env.example .env
  for var in DB_PASSWORD KEYCLOAK_DB_PASSWORD KEYCLOAK_ADMIN_PASSWORD VALKEY_PASSWORD APISIX_ADMIN_KEY ADMIN_API_TOKEN USAGE_INGEST_TOKEN; do
    sed -i "s|^${var}=.*|${var}=$(secret 32)|" .env
  done
  chmod 600 .env
  echo "  .env créé (droits 600). Conservez-le en lieu sûr : il contient tous les secrets."
else
  echo ".env existant conservé."
fi

echo "Construction des images…"
$COMPOSE --env-file .env "${FILES[@]}" build

echo "Démarrage…"
$COMPOSE --env-file .env "${FILES[@]}" up -d

"$ROOT/deploy/scripts/check.sh" --wait
