# ZAPR — Brief de passation pour la V1

> Ce document résume **tout le projet** tel qu'il existe à la fin de la phase
> prototype (nom de travail « pump.social »), pour démarrer la **V1 sous le nom
> ZAPR**. À lire en entier avant de toucher au code.
> Dépôt : `github.com/Kayd-Notion/pump.social` — `main` est à jour.

---

## 1. Le concept

ZAPR est un **réseau social crypto sur Solana**. On publie des posts (texte,
photo, vidéo) et les autres les **« pumpent »** en envoyant du SOL :

- **70 %** vont au **créateur** du post, **30 %** à la **plateforme** (ratio
  réglable, jamais codé en dur) — dans **une seule transaction atomique** à deux
  transferts : soit les deux passent, soit aucun ;
- chaque pump **prolonge la vie** du post : un post vit **24 h** de base, puis
  gagne du temps selon le SOL cumulé, **sans plafond** ; expiré, il est purgé ;
- deux **classements** : posts les plus pumpés et créateurs qui ont reçu le plus,
  **monde ou par pays**, filtrables par **période** (Tout / 24 h / 7 j / 30 j).

Paliers de durée de vie actuels (`src/lib/lifespan-config.ts`, ajustables) :

| SOL cumulés sur le post | Temps gagné |
| --- | --- |
| 0 → 1 SOL | +24 h par SOL |
| 1 → 5 SOL | +12 h par SOL |
| 5 → 20 SOL | +6 h par SOL |
| 20 → 100 SOL | +3 h par SOL |
| 100 SOL et plus | +1,5 h par SOL |

---

## 2. Nouvelle identité : ZAPR

- **Nom** : **ZAPR** (remplace « pump.social » partout dans l'interface).
- **Logo** : éclair jaune sur carré arrondi crème → `public/brand/zapr-logo.png`
  (372×372, capture d'écran recadrée). **À redessiner en SVG** pour la V1
  (favicon, icône d'app, logo du header).
- **DA « jaune électrique »**, couleurs mesurées sur le logo :

| Rôle | Valeur | Note |
| --- | --- | --- |
| Jaune électrique (accent) | `#FED202` | boutons principaux, éclair, chiffres « pumpés » |
| Crème (fond du logo) | `#FDFBF4` | fond du thème clair / cartes |
| Texte sur jaune | `#111111` (quasi noir) | le blanc sur jaune est illisible |
| Fond thème sombre | `#0A0A0B` (actuel) | le jaune ressort très bien dessus |

⚠️ Accessibilité : le **texte jaune sur fond clair** n'est pas lisible. En thème
clair, utiliser le jaune en **fond** (boutons, badges) avec texte noir, et une
variante plus foncée (à définir, type `#B38F00`) pour du texte ou des liens.

**Où ça se change** : les couleurs sont des variables CSS dans
`src/app/globals.css` (`--accent: #10b981` vert émeraude aujourd'hui,
`--accent-strong`, `--accent-soft`, thèmes sombre et clair). Le nom
« pump.social » apparaît notamment dans `src/app/layout.tsx`,
`src/components/AppShell.tsx`, `RightRail.tsx`, `OnboardModal.tsx`,
`src/app/page.tsx`, et dans le message de connexion signé (`AUTH_DOMAIN` /
`src/lib/auth.ts`), les clés de stockage (`ps_token`), les README.

**À décider en V1 (non tranché)** : garde-t-on le verbe **« pump »** ou passe-t-on
à **« zap »** (« Zapper ce post », « 1,6 SOL zappés ») ? L'icône ⚡ est déjà
utilisée pour le pump, ça colle au nom. Même question pour le nom de domaine,
du dépôt GitHub et du projet Vercel.

---

## 3. Ce qui existe et fonctionne

### Parcours (Phase 1, terminée)
- **Connexion wallet** Phantom / Solflare / Backpack via Wallet Standard (pas de
  WalletConnect) avec **choix du wallet** ; preuve de propriété par **signature
  d'un message** (nonce généré et vérifié côté serveur) ; création du **pseudo**.
  Phantom ne s'ouvre plus tout seul à chaque visite.
- **Mode visiteur** : fil lisible sans wallet.
- **Posts** texte + photo/vidéo (médias sur **Arweave via Irys**, payés en SOL
  depuis le wallet connecté).
- **Pump** : montants rapides (0,01 / 0,1 / 0,5 / 1) + saisie libre, aperçu de la
  répartition 70/30, option d'anonymat.
- **Profil** : posts actifs + compteur « X posts expirés » (onglet expirés retiré).
- **Classements** posts / créateurs, monde / pays (pays déduit de l'IP à la volée,
  **jamais stocké**), filtre de période, pagination par curseur, scroll infini.
- Thème sombre/clair, design porté du prototype `MVP.html`.

### Règles produit du pump (vérifiées dans l'interface ET côté serveur)
1. **Auto-pump autorisé** : un créateur peut pumper son post (il ne paie
   réellement que les 30 % + frais). Badge discret **« auto-pump »** dans la liste
   des pumpers ; compte normalement dans les totaux et classements.
2. **Post expiré / purgé** :
   - post **purgé** → pas de bouton Pump, « 🗑️ Post supprimé », serveur refuse ;
   - post **expiré mais pas encore purgé** → la fenêtre affiche « Ce post est
     expiré. Il faut au moins X SOL pour le sauver », pré-remplit ce montant et
     bloque en dessous (sauvé = au moins **1 h** de vie en plus) ;
   - **contrôle serveur juste avant la signature** (`prepare`) ; si le post a été
     purgé entre-temps ou si le montant ne suffit plus → refus, rien n'est signé ;
   - course purge ↔ signature : **réservation de 3 min** qui bloque la purge du
     post ; cas résiduels enregistrés et marqués « à rembourser ».
3. **Minimum 0,005 SOL** par pump (un seul réglage), message « Minimum 0,005 SOL »
   ; refusé aussi par le serveur si l'interface est contournée ; erreurs Solana
   techniques (rent, solde insuffisant, annulation, expiration) **traduites en
   français clair**.

### Envoi de la transaction (dernier correctif)
Le wallet **signe seulement** (`signTransaction`) et **l'app envoie elle-même la
transaction sur son réseau** (devnet) → plus de « Unexpected error » de Phantom
quand il est réglé sur un autre réseau. L'app **simule le pump avant d'ouvrir le
wallet** : un pump voué à l'échec affiche la vraie raison sans rien signer.
Repli automatique sur `sendTransaction` si le wallet ne sait pas « signer
seulement ». Les deux transferts et le 70/30 n'ont pas changé.

---

## 4. Architecture

Deux façons de faire tourner l'app, derrière **un même contrat d'API côté
frontend** (`src/lib/api-types.ts`) :

| Mode | Quand | Données |
| --- | --- | --- |
| **Next.js seul** (utilisé aujourd'hui) | `NEXT_PUBLIC_API_URL` vide | routes `/api/*` de Next + Postgres (Neon) si `DATABASE_URL`, sinon données de démo éphémères |
| **Backend séparé** (mis de côté) | `NEXT_PUBLIC_API_URL=http://…` | API Fastify + Postgres + MinIO, lancés par Docker Compose |

### Frontend — Next.js 15 (App Router) + React 19 + TypeScript (racine du dépôt)
```
src/
  app/                  pages + routes API Next (/api/*)
  components/           AppShell, PostCard, modals (Pump, Composer, Connect…)
  context/              SessionContext (auth wallet), UIContext (thème, modales, toasts)
  hooks/usePump.ts      pump de bout en bout : prepare → simulation → signature → envoi → enregistrement
  lib/
    pump.ts             construction/envoi de la tx de pump — SEUL module à remplacer par le futur programme Anchor
    pump-config.ts      split 70/30, MIN_PUMP_SOL, wallet plateforme
    pump-rules.ts       calcul « minimum pour sauver un post expiré »
    pump-errors.ts      traduction des erreurs wallet/Solana en français
    lifespan(-config).ts paliers de durée de vie
    solana.ts           réseau (devnet par défaut) + garde anti-mainnet
    api.ts / backend-api.ts  les deux sources de données (même contrat)
    db/                 store Postgres (tables créées automatiquement) + store fichier de démo
  db/schema.sql         schéma Postgres du mode Next (idempotent)
tests/                  tests unitaires (npm test) + tests/pump-send.local.mts (validateur local)
```

### Backend séparé — `backend/` (Fastify 5, Postgres, MinIO, Docker Compose)
Plus complet que le mode Next : table `pumps` **append-only** (triggers), posts
purgés gardés en « tombstones », **vérification on-chain** de chaque pump
(expéditeur, destinataires, ratio exact, montant, ancienneté, anti-rejeu),
compteurs dérivés + commande de reconstruction, **purge planifiée** (garde le top
100), réservations de pump, géoloc IP auto-hébergée (DB-IP Lite), uploads
pré-signés MinIO, auth JWT. Tests unitaires + test de bout en bout. Documentation
complète : `backend/README.md`. **Mis de côté** car Docker était trop lourd à
installer ; prévu pour un futur **VPS** (ajouter Caddy/HTTPS).

### Différences importantes du mode Next seul (celui en ligne)
- **Pas de purge automatique** : un post expiré reste visible et peut être sauvé ;
  l'état « Post supprimé » n'apparaît jamais.
- Vérification on-chain seulement si `PUMP_REQUIRE_ONCHAIN_VERIFY=true`.
- Session par cookie httpOnly signé (`SESSION_SECRET`).

---

## 5. Déploiement et configuration

- **En ligne** : https://pump-social.vercel.app (Vercel redéploie à chaque push sur `main`).
- **Base de données** : Neon (Postgres gratuit) à ajouter depuis Vercel →
  Storage → Create Database → Neon → Connect → Redeploy. Le site **crée ses
  tables tout seul** au premier chargement. Console SQL : Storage → Open in Neon
  → SQL Editor.

Variables d'environnement Vercel :

| Variable | Valeur | Rôle |
| --- | --- | --- |
| `DATABASE_URL` | posée par Neon | active Postgres (sinon données de démo qui s'effacent) |
| `SESSION_SECRET` | 32+ caractères aléatoires | signe les sessions de connexion |
| `PUMP_REQUIRE_ONCHAIN_VERIFY` | `true` | le serveur vérifie chaque pump sur Solana |
| `NEXT_PUBLIC_SOLANA_CLUSTER` | `devnet` (défaut) / `testnet` | réseau ; `mainnet-beta` bloque les pumps |
| `NEXT_PUBLIC_SOLANA_RPC` | vide ou URL Helius/QuickNode | RPC custom (le RPC public devnet est limité) |
| `NEXT_PUBLIC_FOUNDER_WALLET` | adresse devnet du fondateur | reçoit les 30 % (sinon une adresse de démo) |
| `NEXT_PUBLIC_PUMP_CREATOR_BPS` / `_FOUNDER_BPS` | 7000 / 3000 | ratio |
| `NEXT_PUBLIC_IRYS_NETWORK` | `devnet` | upload des médias |

Vérifications locales : `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`.

---

## 6. Garde-fous — à ne jamais casser

- **DEVNET par défaut. Aucune transaction ne doit pouvoir toucher du vrai SOL** :
  les pumps sont bloqués sur mainnet dans le code (`src/lib/pump.ts`).
- **Il n'existe pas encore de programme Solana (Anchor)** : un pump = deux
  transferts System directs construits dans le navigateur. Passer au vrai SOL
  exige d'écrire ce programme **et de le faire auditer**.
- Ne pas modifier la répartition 70/30 ni le caractère atomique des deux transferts
  sans décision explicite.
- Toute règle produit se vérifie **dans l'interface ET côté serveur**.
- L'IP des visiteurs n'est **jamais stockée**.

---

## 7. État au moment de la passation / points ouverts

- **Neon pas encore branché** sur Vercel (on voit encore les comptes de démo
  ghostwhale, devSol…) → à faire en premier.
- **SOL de test** : le wallet du fondateur `Aq9pkf9J1yGvW5KHDV2PEPQmPCLi8tKxzd86jy1xNj5d`
  a 3 SOL sur **Testnet** mais **0 sur Devnet** (le faucet devnet limite fort :
  se connecter avec GitHub sur faucet.solana.com). Alternative : passer le site
  en `testnet` (les médias via Irys risquent alors de ne pas marcher).
- Pump de bout en bout **pas encore validé avec Phantom en vrai** depuis le
  correctif « signer seulement » (validé sur un validateur Solana local).
- Petites dettes connues : en mode Postgres, un id de post mal formé renvoie
  probablement une erreur 500 au lieu de 404 (colonne uuid, à vérifier) ; le JWT du backend séparé est en `localStorage`
  (penser CSP avant la prod) ; le RPC public devnet peut limiter le débit.

---

## 8. Pistes pour la V1 (à prioriser ensemble — rien n'est décidé)

1. **Rebranding ZAPR** : nom, logo SVG + favicon, palette jaune (thèmes sombre et
   clair), textes, métadonnées/partage social, éventuellement « pump » → « zap ».
2. Brancher Neon + variables, valider un parcours complet sur devnet avec 2 wallets.
3. Purge des posts expirés dans le mode en ligne (cron Vercel) si on garde ce mode.
4. Programme **Anchor** pour le pump (split on-chain) + audit → prérequis mainnet.
5. Modération (niveau 1), panel admin, bot Telegram, app mobile — hors scope
   jusqu'ici.
6. Backend séparé sur VPS (quand l'échelle le justifie).

---

## 9. Façon de travailler (préférences du fondateur)

- Échanges **en français**, explications **simples**, sans jargon inutile.
- Toujours **lire le code existant avant de modifier** et respecter l'architecture.
- **Tester** chaque changement (unitaires + vrai navigateur quand c'est visuel).
- À la fin de chaque tâche : **résumé fichier par fichier** + **comment tester
  soi-même dans le navigateur**.
- Le fondateur est sur **Windows**, sans outils de dev installés : privilégier ce
  qui se teste **en ligne (Vercel)** sans rien installer.
