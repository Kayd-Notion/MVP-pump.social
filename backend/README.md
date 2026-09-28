# pump.social — API (backend)

Node.js 22 · TypeScript · **Fastify** · Postgres (postgres.js, SQL brut) · MinIO/S3 ·
Solana devnet. Lancement : voir le [README racine](../README.md#backend-local-docker-desktop--windows-10).

```
src/
  server.ts            démarrage : migrations → géoloc → bucket → écoute → purge planifiée
  app.ts               Fastify : CORS, rate limit, erreurs uniformes, routes
  config.ts            toutes les variables d'env, validées au démarrage
  config/lifespan.ts   paliers de durée de vie (ajustables, miroir du frontend)
  routes/              auth, users, media, posts, pumps, leaderboard, meta (health/config/geo)
  lib/solana.ts        vérification on-chain d'un pump
  lib/aggregates.ts    compteurs dérivés (mis à jour en transaction) + reconstruction
  jobs/purge.ts        expiration & suppression réelle
migrations/            SQL versionné, appliqué au démarrage (schema_migrations)
test/                  unit.test.ts (npm test) · e2e.mjs (contre le stack lancé)
```

## Endpoints

Erreurs : `{"error": "<code>", "message": "<texte FR>"}`. Montants en SOL = chaînes
décimales exactes (`"1.600000000"`). Routes 🔒 : `Authorization: Bearer <jwt>` ;
🔒✎ : JWT **et** pseudo déjà créé.

| Méthode | Route | |
| --- | --- | --- |
| GET | `/health` | Postgres + stockage + géoloc (healthcheck Docker) |
| GET | `/config` | wallet plateforme, ratio, cluster, types/poids médias acceptés |
| GET | `/geo` | pays du visiteur (IP → pays à la volée, non stocké) |
| POST | `/auth/nonce` `{wallet}` | défi à usage unique, expire en 5 min → `{nonce, message}` |
| POST | `/auth/verify` `{wallet, message, signature}` | vérifie la signature ed25519, consomme le nonce → `{token, needs_pseudo, user}` |
| GET 🔒 | `/me` | `{wallet, user, needs_pseudo}` |
| POST 🔒 | `/users` `{pseudo}` | crée le pseudo (unique, insensible à la casse) |
| PATCH 🔒✎ | `/users/me` `{pseudo}` | change de pseudo |
| GET | `/users/:pseudo` | profil, posts actifs, `posts_count`, `expired_count` |
| POST 🔒✎ | `/media/presign` `{content_type, size}` | formulaire POST pré-signé → upload direct navigateur → MinIO |
| POST 🔒✎ | `/posts` `{texte, media_key?}` | crée le post (expiration = maintenant + 24 h) |
| GET | `/feed?cursor=&limit=` | posts non supprimés, du plus récent, pagination par curseur |
| GET | `/posts/:id` | post (tombstone s'il est purgé) + ses derniers pumps |
| GET | `/posts/:id/pump-quote` | état du post pour la modale : `active` / `expired` / `deleted`, minimum requis |
| POST 🔒✎ | `/pumps/prepare` `{post_id, amount_sol}` | contrôle **juste avant la signature** + réservation courte (voir règles) |
| POST 🔒✎ | `/pumps` `{post_id, tx_signature, amount_sol, intent_id?}` | vérifie la transaction on-chain puis enregistre |
| GET | `/leaderboard/posts` · `/leaderboard/creators` | `period=all\|24h\|7d\|30d`, `scope=world\|country`, `country=XX`, `cursor`, `limit` |

## Choix de conception

**Posts supprimés = tombstones.** La purge efface réellement le contenu (texte,
média dans MinIO) et pose `deleted_at`, mais la ligne `posts` reste avec son
auteur et son pays. `pumps.post_id` garde donc une clé étrangère valide
(`ON DELETE RESTRICT`), et les classements par période continuent d'afficher un
« post supprimé » s'il a reçu des pumps dans la fenêtre.

**`pumps` est append-only**, garanti par la base : des triggers rejettent
`UPDATE`, `DELETE` et `TRUNCATE`. Chaque ligne enregistre aussi le partage
vérifié on-chain (`creator_amount_sol`, `platform_amount_sol`) : le ratio est
configurable, donc on ne le recalcule jamais après coup.

**Pays.** L'IP n'est jamais stockée. À la création d'un post, le pays de
l'auteur (code ISO, déduit de son IP à cet instant) est enregistré sur le post.
C'est lui qui définit « posts / créateurs · FR ». Pour le visiteur, le pays sert
seulement de valeur par défaut du filtre, calculé à chaque requête. Base
auto-hébergée : DB-IP Lite (CC BY 4.0). Un pays « créateur » = les pumps reçus
sur ses posts publiés depuis ce pays.

**Vérification d'un pump** (`lib/solana.ts`). Rien n'est écrit avant que la
transaction soit **confirmée** et conforme :
- signée par le wallet authentifié ;
- transferts System uniquement vers le wallet du créateur du post et le wallet
  plateforme configuré ; tout autre destinataire est refusé ;
- parts exactement égales au ratio configuré (arrondi identique au frontend) ;
- total égal au montant déclaré. Le montant enregistré est celui lu on-chain,
  jamais celui déclaré par le client ;
- moins de `PUMP_MAX_TX_AGE_SECONDS` d'ancienneté, pour qu'un ancien transfert
  vers le créateur ne puisse pas être réclamé comme pump ;
- `tx_signature` unique en base (anti-rejeu, y compris en cas de requêtes
  simultanées).

La durée de vie est ensuite recalculée depuis les paliers de
`config/lifespan.ts`, et n'est jamais raccourcie.

**Classement « Tout » : pourquoi ne pas sommer toute la table.** Sommer `pumps`
depuis le début grossirait avec l'historique. Les totaux « depuis toujours »
sont donc des **compteurs dérivés** (`posts.total_pumped_sol`,
`users.total_received_sol`, `creator_country_totals`). Ils sont mis à jour
**dans la même transaction** que l'insertion du pump, et lus via un index
`(total desc, id)`, soit une ligne par post ou créateur. `pumps` reste la source
de vérité : `npm run rebuild-aggregates` recalcule tout depuis elle. Les périodes
24h/7j/30j somment `pumps` sur la fenêtre via un index couvrant sur
`created_at`. Si le volume de 30j devient important, l'étape suivante est une
table de cumuls journaliers, sans changer l'API.

**Pagination par curseur partout** (feed et classements) : curseur opaque =
clé de tri `(total, id)` ou `(created_at, id)` de la dernière ligne. Les sommes
sont en `numeric` exact, donc les ex æquo se paginent de façon stable, sans
doublon ni trou.

**Purge** (`jobs/purge.ts`, toutes les `PURGE_INTERVAL_SECONDS`) :
- posts expirés **hors top `KEEP_TOP_N`** (défaut 100) du classement « Tout »
  parmi les posts pumpés : suppression du média, puis tombstone ;
- uploads jamais rattachés à un post (après 1 h) ;
- nonces expirés.

Un verrou consultatif Postgres garantit qu'une seule instance exécute la purge.

**Uploads.** Formulaire POST pré-signé : c'est MinIO qui impose le type et la
taille maximale (la taille déclarée). La clé est rangée sous
`media/<wallet>/…`. Le post ne peut rattacher qu'un upload du même wallet, pas
encore utilisé, et dont le fichier correspond à ce qui a été annoncé.

**Auth.** Le JWT HS256 (7 jours) est renvoyé en Bearer, sans cookie
cross-origin. Il est stateless : se déconnecter = oublier le token côté client.
Le frontend le garde dans `localStorage`, donc une faille XSS pourrait le lire :
à garder en tête (CSP) avant la prod.

## Règles produit du pump

Chaque règle est vérifiée dans l'interface **et** par l'API. Le code des
règles est dans `lib/pump-rules.ts`.

**1. Auto-pump autorisé.** Un créateur peut pumper son propre post. Aucune
logique spéciale : il reçoit ses propres 70 %, donc son coût réel est les 30 %
plateforme plus les frais. Chaque pump porte `is_self_pump`, une colonne
calculée par Postgres (`from_wallet = to_creator_wallet`) : elle ne peut pas
être fausse. Le pump compte dans les totaux et les classements comme les autres.

**2. Post expiré ou purgé.**
- **Post purgé** : `pump-quote` renvoie `deleted`, l'interface n'affiche pas de
  bouton Pump, et `POST /pumps/prepare` refuse (`409 post_deleted`).
- **Post expiré, pas encore purgé** : `pump-quote` donne le minimum qui repousse
  l'expiration à au moins maintenant + `PUMP_SAVE_MIN_LIFETIME_SECONDS` (1 h par
  défaut). Il est calculé avec les paliers de `config/lifespan.ts` et arrondi au
  millième au-dessus. La modale le pré-remplit et exige au moins ce montant.
- **Juste avant la signature** : le client appelle `POST /pumps/prepare`, qui
  recalcule tout à cet instant, sous verrou de la ligne du post. Si le post a
  été purgé entre-temps, il refuse avec `post_deleted`. Si le montant ne suffit
  plus, il refuse avec `amount_too_low_to_save` et renvoie le nouveau
  `required_min_sol`. Dans les deux cas, aucune transaction n'est présentée au
  wallet.
- **Course purge / confirmation** : `prepare` crée une réservation
  (`pump_intents`, `PUMP_INTENT_TTL_SECONDS` = 3 min, plus long que la durée de
  validité d'une transaction Solana). La purge prend le même verrou et **reporte**
  tout post qui a une réservation active. La réservation est close quand le pump
  est enregistré.
- **Cas résiduels** (client qui saute `prepare`, ou qui plante après la
  confirmation) : un transfert arrivé sur un post déjà purgé est **quand même
  enregistré**, avec `recorded_after_purge = true`, et journalisé
  (`PUMP_AFTER_PURGE`). Une réservation expirée sans pump enregistré est
  journalisée (`PUMP_INTENT_UNRESOLVED`). Pour les remboursements manuels :
  ```sql
  select * from pumps where recorded_after_purge;
  select * from pump_intents where flagged_at is not null;  -- à vérifier on-chain
  ```

**3. Montant minimum.** `MIN_PUMP_SOL` (0,005 par défaut) est défini à un seul
endroit : `config.ts`, via l'env. Le frontend le lit dans `GET /config`.
`prepare` et `POST /pumps` refusent tout montant inférieur (`below_min_pump`),
même si l'interface est contournée. À 0,005 SOL, les deux parts (70/30)
dépassent le minimum de rent Solana d'un wallet vide. Si une transaction échoue
quand même pour cette raison (par exemple avec un autre ratio), l'interface
affiche un message clair plutôt que l'erreur brute.

## Vers le VPS (session suivante)

Le compose est prêt tel quel. À ajouter ou changer :
- **Caddy** devant `api` (ex. `api.<domaine>`) et `minio` (`media.<domaine>`) ;
- dans `.env` :
  - `TRUST_PROXY=true` ;
  - `CORS_ORIGINS=https://pump-social.vercel.app` ;
  - `S3_PUBLIC_URL=https://media.<domaine>` ;
  - `AUTH_DOMAIN=<domaine>` ;
  - `DEV_DEFAULT_COUNTRY=` vide ;
  - des secrets neufs ;
- retirer le port Postgres s'il ne sert pas ;
- sauvegarder les volumes `pgdata` et `miniodata` ;
- de préférence, une clé MinIO dédiée à l'API au lieu des identifiants root.
