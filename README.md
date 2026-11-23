# Plateforme API Management — SMT

Point d'entrée unique des banques vers les services SMT : la plateforme consomme les API des fournisseurs (SVIP vers SmartVista, SMT Cockpit, plateforme Chargeback, Plateforme 1) et les expose aux banques sous forme d'écrans (portail) et d'API, avec contrat, mise en service, abonnements, quotas, sécurité, facturation, engagements de service et audit.

Tous les composants sont gratuits et open source ; seul le système RHEL est payant.

## Prérequis

- RHEL 9 avec Podman 4.9+ et `podman compose` (ou Docker Engine + Docker Compose sur un poste de développement).
- 4 vCPU, 8 Go de RAM, 20 Go de disque pour le socle complet.
- `openssl` et `curl`. Node.js 22 uniquement pour développer le back-end hors conteneur.

## Démarrage

```bash
deploy/scripts/init.sh --dev   # génère .env, construit, démarre, attend que tout soit sain
deploy/scripts/check.sh        # état de santé à tout moment
deploy/scripts/qa-lot1.sh      # recette du lot 1 à travers la vraie passerelle
```

Le premier démarrage prend plusieurs minutes : ClamAV télécharge ses signatures antivirales.
Avec Docker au lieu de Podman : `COMPOSE="docker compose" ENGINE=docker deploy/scripts/init.sh --dev`.

Arrêt : `podman compose --env-file .env -f deploy/compose.yaml down` (ajouter `-v` efface les données).

## Services

| Service | Rôle | Port local (`--dev`) |
|---|---|---|
| apisix | Passerelle : seul point d'entrée des banques | 9080 (exposé), admin 9180 |
| etcd | Configuration d'APISIX | — |
| backend | Back-end NestJS : métier, console, BFF du portail | 3000 |
| postgres | Base de la plateforme et de Keycloak | 5432 |
| valkey | Droits, quotas et débits lus par la passerelle | 6379 |
| keycloak | Identité et rôles (royaume `smt`) | 8081 |
| seaweedfs | Fichiers : pièces, PV, bibliothèque (API S3) | 8333 |
| clamav | Antivirus des pièces déposées | — |
| simulateur | Faux fournisseur derrière la sandbox | 8080 |

Sans `--dev`, seul le port de la passerelle est exposé.

## Configuration

Toutes les variables sont décrites dans `.env.example`. `init.sh` crée `.env` avec des secrets aléatoires (droits 600) ; ce fichier n'est jamais versionné.

Une passerelle sert un seul environnement (`GATEWAY_ENVIRONMENT`) : `SANDBOX` envoie les appels aux simulateurs, `PRODUCTION` aux vrais fournisseurs. En production, on déploie une instance par environnement.

## Arborescence

```
backend/            back-end NestJS (src/, test/, Containerfile)
gateway/apisix/     plugins Lua de la passerelle (subscription-guard)
deploy/             compose, configuration APISIX, royaume Keycloak, scripts
CLAUDE.md           contexte du projet : contraintes, architecture, conventions, avancement
```

## Tests du back-end

```bash
cd backend && npm ci && npm test
```

## Limites connues du lot 1

- Une instance de chaque service : pas de haute disponibilité (prévue au lot de mise en production).
- Schéma de base créé automatiquement (`DB_SYNCHRONIZE=true`) : migrations versionnées avant la production.
- Keycloak est démarré mais pas encore branché au back-end ni au portail (lot 2).
- OpenSearch n'est pas inclus (lot 5).
