#!/usr/bin/env bash
# QA du lot 1 : parcours de bout en bout à travers la VRAIE passerelle APISIX.
# Prérequis : socle démarré avec init.sh --dev (back-end sur 127.0.0.1:3000, passerelle sur :9080).
# Chaque exécution crée ses propres données (suffixe horodaté) : relançable à volonté.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
set -a; source "$ROOT/.env"; set +a
API="${BACKEND_URL:-http://127.0.0.1:3000}"
GW="${GATEWAY_URL:-http://127.0.0.1:${GATEWAY_PORT:-9080}}"
AUTH=(-H "Authorization: Bearer $ADMIN_API_TOKEN" -H "x-actor: qa-lot1" -H "Content-Type: application/json")
RUN=$(date +%H%M%S)
PASS=0; FAIL=0

ok()   { echo "  OK   $1"; PASS=$((PASS+1)); }
ko()   { echo "  KO   $1"; FAIL=$((FAIL+1)); }
post() { curl -s "${AUTH[@]}" -X POST "$API$1" -d "${2:-{\}}"; }
json() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const v=JSON.parse(s)$1;console.log(v??'')}catch{console.log('')}})"; }
expect_code() { # libellé, code attendu, curl…
  local label=$1 want=$2; shift 2
  local got; got=$(curl -s -o /tmp/qa-body -w '%{http_code}' "$@")
  if [[ "$got" == "$want" ]]; then ok "$label ($got)"; else ko "$label : attendu $want, obtenu $got — $(head -c 200 /tmp/qa-body)"; fi
}

echo "1. Santé"
"$ROOT/deploy/scripts/check.sh" >/tmp/qa-check 2>&1 && ok "tous les services sont sains" || { ko "services non sains"; cat /tmp/qa-check; }
expect_code "back-end voit base, Valkey et APISIX" 200 "$API/health/ready"
expect_code "console d'administration protégée" 401 "$API/partners"

echo "2. Catalogue"
PROV=$(post /providers '{"name":"Simulateur QA '"$RUN"'","baseUrl":"http://simulateur:8080","sandboxBaseUrl":"http://simulateur:8080"}' | json .id)
[[ -n "$PROV" ]] && ok "fournisseur créé" || ko "fournisseur"
APIID=$(post /apis '{"name":"Echo QA","slug":"echo-qa-'"$RUN"'","publicPath":"/qa'"$RUN"'/v1","upstreamPath":"/echo","providerId":"'"$PROV"'"}' | json .id)
[[ -n "$APIID" ]] && ok "service créé" || ko "service"
expect_code "service publié" 201 "${AUTH[@]}" -X POST "$API/apis/$APIID/status" -d '{"status":"PUBLISHED"}'
PLAN=$(post /plans '{"name":"QA '"$RUN"'","dailyQuota":3,"rateLimitPerSecond":10}' | json .id)
[[ -n "$PLAN" ]] && ok "plan créé (quota 3 appels / jour)" || ko "plan"

echo "3. Banques"
mkpartner() { # code -> "id clé"
  local id key
  id=$(post /partners '{"code":"'"$1"'","name":"Banque '"$1"'"}' | json .id)
  post "/partners/$id/activate" >/dev/null
  key=$(post "/partners/$id/api-key" | json .apiKey)
  echo "$id $key"
}
read -r P1 K1 <<<"$(mkpartner "QA1_$RUN")"
read -r _ K2 <<<"$(mkpartner "QA2_$RUN")"
[[ -n "$K1" && -n "$K2" ]] && ok "deux banques actives avec clé d'API" || ko "banques"

echo "4. Abonnement (sandbox) de la banque 1 seulement"
SUB=$(post /subscriptions '{"partnerId":"'"$P1"'","apiId":"'"$APIID"'","planId":"'"$PLAN"'","environment":"SANDBOX"}' | json .id)
expect_code "abonnement validé" 200 "${AUTH[@]}" -X POST "$API/subscriptions/$SUB/validate"
PROD=$(curl -s -o /dev/null -w '%{http_code}' "${AUTH[@]}" -X POST "$API/subscriptions" -d '{"partnerId":"'"$P1"'","apiId":"'"$APIID"'","planId":"'"$PLAN"'"}')
[[ "$PROD" == "409" ]] && ok "production refusée sans mise en service (409)" || ko "production sans mise en service : $PROD"
sleep 2 # propagation etcd -> APISIX

echo "5. Appels à travers la passerelle"
URL="$GW/qa$RUN/v1/ping"
expect_code "sans clé : refusé" 401 "$URL"
expect_code "clé inconnue : refusé" 401 -H "apikey: faux" "$URL"
expect_code "banque 2 sans abonnement : refusé" 403 -H "apikey: $K2" "$URL"
expect_code "banque 1 abonnée : appel 1 accepté" 200 -H "apikey: $K1" "$URL"
grep -q '"simulateur":true' /tmp/qa-body && ok "réponse du simulateur reçue (jamais de vrai fournisseur en sandbox)" || ko "réponse inattendue"
grep -q '"path":"/echo/ping"' /tmp/qa-body && ok "chemin réécrit vers le fournisseur" || ko "réécriture du chemin"
grep -q '"apikeyReceived":false' /tmp/qa-body && ok "clé de la banque masquée au fournisseur" || ko "clé transmise au fournisseur"
grep -qi '^x-request-id' <(curl -s -D - -o /dev/null -H "apikey: $K1" "$URL") && ok "identifiant de requête renvoyé (appel 2)" || ko "pas d'X-Request-Id"
expect_code "appel 3 accepté" 200 -H "apikey: $K1" "$URL"
expect_code "appel 4 : quota dépassé" 429 -H "apikey: $K1" "$URL"

echo "6. Suspension"
expect_code "abonnement suspendu" 200 "${AUTH[@]}" -X POST "$API/subscriptions/$SUB/suspend" -d '{"reason":"QA"}'
sleep 2
expect_code "abonnement suspendu : refusé" 403 -H "apikey: $K1" "$URL"

echo "7. Comptage pour la facturation"
sleep 8 # envoi par lots du http-logger
TODAY=$(TZ=Africa/Tunis date +%F)
CALLS=$(curl -s "${AUTH[@]}" "$API/usage/summary?from=$TODAY&to=$TODAY&partner=QA1_$RUN" | json "[0]?.calls")
[[ "${CALLS:-0}" -ge 3 ]] && ok "appels comptés : $CALLS" || ko "appels comptés : ${CALLS:-0} (attendu ≥ 3)"

echo
echo "Résultat : $PASS OK, $FAIL KO"
[[ $FAIL -eq 0 ]]
