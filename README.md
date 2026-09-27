# pump.social — frontend web (Next.js)

Réseau social crypto sur **Solana** où l'on « pump » les posts en SOL pour
prolonger leur durée de vie et grimper dans deux classements (posts /
créateurs). Ce dépôt porte le prototype `MVP.html` vers un vrai projet
**Next.js (App Router) + TypeScript** et implémente le parcours complet de la
**Phase 1** du roadmap.

> ⚠️ **Sécurité — DEVNET par défaut.** Aucune transaction ne peut toucher du SOL
> réel : le réseau est sur `devnet` et les pumps sont bloqués sur `mainnet` tant
> que le programme on-chain n'est pas audité (cf. guide, Phases 2‑3). Basculer
> plus tard = une variable d'env.

## Démarrage

```bash
npm install
cp .env.example .env.local   # les défauts sont sûrs (devnet + store local)
npm run dev                  # http://localhost:3000
```

L'app tourne immédiatement, feed pré-rempli (données seed), **sans base de
données à provisionner** : le store local suffit pour développer/tester.

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

## Configuration (`.env`)

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
```
