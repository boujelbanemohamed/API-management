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

# 32 caractères hexadécimaux, sans tube (robuste avec pipefail).
secret() { openssl rand -hex 16; }

if [[ ! -f .env ]]; then
  echo "Génération de .env…"
  cp .env.example .env
  for var in DB_PASSWORD KEYCLOAK_DB_PASSWORD KEYCLOAK_ADMIN_PASSWORD VALKEY_PASSWORD APISIX_ADMIN_KEY ADMIN_API_TOKEN USAGE_INGEST_TOKEN RABBITMQ_PASSWORD COCKPIT_SHARED_SECRET KEYCLOAK_BACKEND_SECRET; do
    sed -i "s|^${var}=.*|${var}=$(secret)|" .env
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
