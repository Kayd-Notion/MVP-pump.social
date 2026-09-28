# pump.social

Frontend web **Next.js** (racine du dépôt) + backend **Node.js/Fastify**
(`backend/`, lancé avec Docker Compose avec Postgres et MinIO).

Réseau social crypto sur **Solana** où l'on « pump » les posts en SOL pour
prolonger leur durée de vie et grimper dans deux classements (posts /
créateurs). Ce dépôt porte le prototype `MVP.html` vers un vrai projet
**Next.js (App Router) + TypeScript** et implémente le parcours complet de la
**Phase 1** du roadmap.

> ⚠️ **Sécurité — DEVNET par défaut.** Aucune transaction ne peut toucher du SOL
> réel : le réseau est sur `devnet` et les pumps sont bloqués sur `mainnet` tant
> que le programme on-chain n'est pas audité (cf. guide, Phases 2‑3). Basculer
> plus tard = une variable d'env.

## Le plus simple : en ligne, sans rien installer

Le site est déployé par Vercel à chaque mise à jour de `main`
(https://pump-social.vercel.app). Sans base de données, il tourne avec des
données de démo qui **s'effacent** régulièrement. Pour garder tes posts et tes
pumps, ajoute une base Postgres gratuite depuis le tableau de bord Vercel :

1. [vercel.com](https://vercel.com) → projet **pump-social** → onglet **Storage**.
2. **Create Database** → **Neon** (Serverless Postgres) → plan gratuit → région
   Europe (Frankfurt) → **Create**, puis **Connect** au projet (tous les
   environnements).
3. Onglet **Deployments** → sur le dernier déploiement, **⋯ → Redeploy**.

C'est tout : Vercel fournit `DATABASE_URL` au site, qui crée ses tables tout
seul au premier chargement (feed vide au départ). Aucun terminal, aucun Docker.
La base se consulte et se modifie dans le navigateur : Storage → ta base →
**Open in Neon** → **SQL Editor**.

Le backend Docker (`backend/`, section plus bas) reste disponible pour plus
tard, mais il n'est pas nécessaire pour tester l'app.

## Démarrage en local (développeurs)

```bash
npm install
cp .env.local.example .env.local   # les défauts sont sûrs (devnet + store local)
npm run dev                        # http://localhost:3000
```

L'app tourne immédiatement, feed pré-rempli (données seed), **sans base de
données à provisionner** : le store local suffit pour développer/tester.

## Backend local (Docker Desktop · Windows 10)

Le stack `docker-compose.yml` (racine) lance **Postgres**, **MinIO** (stockage
S3 des médias) et l'**API** (`backend/`). Le même fichier servira tel quel sur le
VPS : on n'y ajoutera qu'un reverse proxy HTTPS.

| Service | URL locale | Rôle |
| --- | --- | --- |
| API | http://localhost:4000 | REST (auth wallet, posts, pumps, classements) — `GET /health` |
| MinIO | http://localhost:9000 | upload direct des médias + URLs publiques |
| Console MinIO | http://localhost:9001 | interface web (login = `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD`) |
| Postgres | `localhost:5432` | base (pour un client SQL, facultatif) |

Tous les ports sont liés à `127.0.0.1` : rien n'est visible depuis ton réseau.

### 1. Premier lancement (PowerShell, dans le dossier du dépôt)

Pré-requis : Docker Desktop démarré (moteur WSL2).

```powershell
cd C:\chemin\vers\pump.social
git pull

# Config du stack : copier le modèle puis le compléter
Copy-Item .env.example .env
notepad .env
```

Dans `.env`, change au minimum :
- `POSTGRES_PASSWORD` et `MINIO_ROOT_PASSWORD` (8 caractères min. pour MinIO) ;
- `JWT_SECRET` : 32 caractères aléatoires minimum. Pour en générer un :
  ```powershell
  $b = New-Object byte[] 48; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [Convert]::ToBase64String($b)
  ```
- `PLATFORM_WALLET` : un wallet **devnet** à toi (il reçoit les 30 %).

Puis :

```powershell
docker compose up -d --build     # 1er build : quelques minutes
docker compose ps                # les 3 services doivent être "Up", l'API "(healthy)"
Invoke-RestMethod http://localhost:4000/health   # → ok=True db=True storage=True geo=True
```

Au démarrage, l'API applique les migrations SQL, crée le bucket MinIO et charge
la base de géoloc IP (téléchargée au build).

### 2. Brancher le frontend sur ce backend

Dans **`.env.local`** (frontend), ajoute **une ligne** :

```
NEXT_PUBLIC_API_URL=http://localhost:4000
```

puis relance `npm run dev`. C'est tout : le wallet plateforme et le ratio 70/30
sont lus depuis le backend (`GET /config`), le RPC reste devnet. Pour revenir
aux données de démo (mode preview Vercel), vide ou commente cette ligne.

Pour tester connexion, post et pump : Phantom (ou autre) en **Devnet**, avec du
SOL de test ([faucet.solana.com](https://faucet.solana.com)).

### 3. Au quotidien

```powershell
docker compose ps                    # état des services
docker compose logs -f api           # logs de l'API en direct (Ctrl+C pour quitter)
docker compose logs --tail 100 minio # 100 dernières lignes d'un service
docker compose stop                  # tout arrêter (données conservées)
docker compose start                 # relancer après un stop
docker compose restart api           # redémarrer l'API seule
docker compose up -d --build api     # reconstruire l'API après un git pull
docker compose down                  # arrêter + supprimer les conteneurs (données conservées)
```

⚠️ `docker compose down -v` **efface les volumes** (base + médias) : repartir de zéro.

Outils :

```powershell
docker compose exec postgres psql -U pump -d pump   # console SQL (\q pour quitter)
docker compose exec api npm run purge               # lancer la purge des posts expirés maintenant
docker compose exec api npm run rebuild-aggregates  # recalculer tous les totaux depuis la table pumps
docker compose build --no-cache api                 # rebuild complet (rafraîchit aussi la base de géoloc)
```

### Tests du backend

```powershell
cd backend
npm install
npm test                 # tests unitaires (sans Docker)
node test/e2e.mjs        # bout en bout contre le stack lancé (auth, upload, pumps on-chain, classements)
```

Le test de bout en bout envoie de vraies transactions devnet : si le faucet
public refuse l'airdrop, fournis un wallet devnet approvisionné (≥ 3 SOL, fichier JSON au
format `solana-keygen`) :

```powershell
$env:PUMPER_KEYPAIR = "C:\chemin\vers\keypair-devnet.json"; node test/e2e.mjs
```

Pour tester aussi les posts expirés / purgés (règle 2), le test a besoin
d'accéder à la base afin de faire vieillir un post. Mets `PURGE_ENABLED=false`
dans `.env` (puis `docker compose up -d`), et lance :

```powershell
$env:E2E_DATABASE_URL = "postgres://pump:<POSTGRES_PASSWORD>@localhost:5432/pump"; node test/e2e.mjs
```

### À propos de MinIO

Depuis 2025, MinIO ne publie plus d'image Docker ni de binaire pour son édition
communautaire (l'image `minio/minio` n'est plus téléchargeable publiquement).
Le compose utilise **`pgsty/minio`**, des builds communautaires du même code
source MinIO maintenus par le projet Pigsty, épinglés sur une release précise.
L'API ne parle que le protocole S3 standard : pour changer d'implémentation
(RustFS, SeaweedFS, S3 managé…), il suffit de changer `MINIO_IMAGE` ou le service
dans le compose, sans toucher au code.

La géolocalisation IP utilise **DB-IP Lite** (CC BY 4.0, attribution « IP
Geolocation by DB-IP » à afficher dans les mentions légales), téléchargée au
build. Aucune API externe n'est appelée, et l'IP n'est jamais stockée.

Détails de l'API, des choix de modèle et de la vérification on-chain :
[`backend/README.md`](backend/README.md).

## Stack & décisions structurantes

| Brique | Choix | Note |
| --- | --- | --- |
| Front | Next.js 15 (App Router) + TypeScript | design system de `MVP.html` porté tel quel (`globals.css`) |
| Wallet | `@solana/wallet-adapter-react` (Wallet Standard) | détection injectée Phantom / Solflare / Backpack, **pas WalletConnect**, UI custom |
| Auth | Sign‑in‑with‑Solana | nonce généré **côté serveur**, signature vérifiée **côté serveur** (ed25519), session JWT httpOnly |
| Transactions | `@solana/web3.js` | pump = 1 tx atomique à 2 transferts (créateur + fondateur) |
| Upload média | `@irys/web-upload` + `@irys/web-upload-solana` | Arweave **payé en SOL depuis le wallet connecté** (pas de wallet Arweave séparé) |
| Base de données | **Postgres managé (Supabase / Neon)** | via `postgres.js`, derrière une interface `Store` ; store fichier par défaut en dev |

### Choix de base de données — à valider

Aucune BDD n'était encore actée. Proposition retenue : **Postgres managé
(Supabase ou Neon)** — gratuit pour démarrer, simple à opérer, accessible depuis
les routes API Next.js. Pour ne pas bloquer le dev, l'accès aux données passe par
une interface unique (`src/lib/db`) avec **deux implémentations** :

- **store fichier** (défaut, `DATABASE_URL` vide) : JSON dans `.data/`, seedé avec
  les données du prototype → l'app tourne sans rien provisionner ;
- **Postgres** (`DATABASE_URL` défini) : `src/lib/db/postgres.ts` + schéma
  `src/db/schema.sql`.

Passer à Supabase :

```bash
# .env.local
DATABASE_URL=postgres://user:pass@host:5432/postgres?sslmode=require
npm run db:seed   # applique le schéma + seed initial
```

Base déjà existante : `npm run db:setup` applique aussi les migrations (idempotent,
sans perte de données).

## Configuration du frontend (`.env.local`)

| Variable | Rôle |
| --- | --- |
| `NEXT_PUBLIC_SOLANA_CLUSTER` | `devnet` (défaut) / `testnet` / `mainnet-beta` |
| `NEXT_PUBLIC_SOLANA_RPC` | RPC custom (Helius/QuickNode) — sinon RPC public du cluster |
| `NEXT_PUBLIC_PUMP_CREATOR_BPS` / `NEXT_PUBLIC_PUMP_FOUNDER_BPS` | split en points de base (défaut 7000/3000) |
| `NEXT_PUBLIC_FOUNDER_WALLET` | wallet de Kayd qui reçoit la part plateforme |
| `SESSION_SECRET` | secret de signature du cookie de session |
| `PUMP_REQUIRE_ONCHAIN_VERIFY` | `true` en prod : re‑vérifie chaque pump on-chain avant enregistrement |
| `DATABASE_URL` | vide = store fichier ; sinon Postgres |
| `NEXT_PUBLIC_IRYS_NETWORK` | `devnet` (défaut) / `mainnet` |

## Où vivent les paramètres ajustables

- **Split 70/30** → `src/lib/pump-config.ts` (piloté par env, jamais en dur).
- **Logique de pump on-chain** → `src/lib/pump.ts` — **le seul module à
  remplacer** par un appel au futur programme Anchor.
- **Paliers de durée de vie** → `src/lib/lifespan-config.ts` (valeurs par défaut
  raisonnables, ajustables sans toucher à la logique `src/lib/lifespan.ts`).

## Mapping Phase 1 (guide §Phase 1)

- [x] Auth wallet (Wallet Standard) + création de pseudo
- [x] Mode visiteur — feed en lecture seule sans wallet
- [x] Publication de post (texte + photo/vidéo, upload Arweave via Irys payé en SOL)
- [x] Mécanique de pump — boutons rapides + saisie libre, split 70/30 configurable, tx atomique 2 transferts
- [x] Durée de vie dynamique (24h + paliers à chaque pump, sans plafond)
- [x] Leaderboard posts + créateurs, mondial & par pays (géoloc IP à la volée, non stockée), scroll infini
- [x] Filtre par période (Tout / 24h / 7 jours / 30 jours) combinable avec posts/créateurs et monde/pays —
      sommes calculées depuis le journal des pumps (table `pumps`), pagination par curseur
- [ ] Modération niveau 1 — **hors scope de cette session** (Phase 2)

Hors scope (rappel) : modération IA & panel admin, bot Telegram, programme Anchor
on-chain réel, app mobile.

## Architecture

```
src/
  app/                 pages (App Router) + routes API (/api/*)
  components/          AppShell, PostCard, modals, ...
  context/             SessionContext (auth wallet), UIContext (thème, modales, toasts)
  hooks/usePump.ts     pump bout-en-bout (tx client → enregistrement serveur)
  lib/
    pump.ts            construction/envoi de la tx de pump (point d'isolation Anchor)
    pump-config.ts     split configurable
    lifespan-config.ts paliers de durée de vie
    lifespan.ts        calcul de la durée de vie
    solana.ts          cluster/connexion (devnet par défaut)
    irys.ts            upload Arweave payé en SOL
    auth.ts / session.ts  SIWS + session JWT httpOnly
    geo.ts             pays depuis l'IP (à la volée, non stockée)
    db/                interface Store + impl fichier & Postgres + seed
  db/schema.sql        schéma Postgres
scripts/setup-db.mjs   application du schéma + seed Postgres
```

## Vérification

```bash
npm run typecheck   # tsc --noEmit
npm run build       # build de prod
npm run lint
npm test            # tests unitaires frontend (règles du pump)
```

Les règles produit du pump (auto-pump, post expiré ou purgé, montant minimum)
sont décrites dans [`backend/README.md`](backend/README.md#règles-produit-du-pump).
