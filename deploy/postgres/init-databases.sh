#!/bin/bash
# Exécuté une seule fois par PostgreSQL au premier démarrage (volume vide).
# Crée la base de Keycloak et son utilisateur ; la base de la plateforme est créée par l'image (POSTGRES_DB).
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-SQL
  CREATE USER keycloak WITH PASSWORD '${KEYCLOAK_DB_PASSWORD}';
  CREATE DATABASE keycloak OWNER keycloak;
  REVOKE ALL ON DATABASE keycloak FROM PUBLIC;
  REVOKE ALL ON DATABASE ${POSTGRES_DB} FROM PUBLIC;
SQL
