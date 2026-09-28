// End-to-end test against a RUNNING stack (docker compose up -d).
//
//   node test/e2e.mjs
//
// Env:
//   API_URL   default http://localhost:4000
//   RPC_URL   Solana RPC the API is configured with (default devnet). On devnet
//             the public faucet is often rate-limited: pass a funded keypair
//             with PUMPER_KEYPAIR=path/to/keypair.json (solana-keygen format,
//             ≥ 3 SOL: the test sends ~2.5 SOL of pumps).
//   E2E_DATABASE_URL  enables the rule-2 checks (expired/purged posts need
//             direct DB access to time-travel), e.g.
//             postgres://pump:<POSTGRES_PASSWORD>@localhost:5432/pump
//             Also runs the purge via `docker compose exec` (E2E_PURGE_CMD).
//             Tip: PURGE_ENABLED=false in .env avoids the scheduled purge
//             racing these checks.
//
// Covers: auth (nonce/verify/JWT/pseudo), media upload via presigned POST,
// posts/feed, on-chain pump verification (valid + every rejection case),
// anti-replay, leaderboards (periods, scopes, cursor pagination), and the pump
// product rules (self-pump, expired/purged posts, minimum amount).
import { readFileSync } from "node:fs";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";

const API = process.env.API_URL ?? "http://localhost:4000";
const RPC = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const conn = new Connection(RPC, "confirmed");

let failures = 0;
function check(name, cond, extra = "") {
  console.log(`${cond ? "  ✓" : "  ✗"} ${name}${!cond && extra ? `  → ${extra}` : ""}`);
  if (!cond) failures++;
}

async function api(method, path, { token, body } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, body: json };
}

async function signIn(kp) {
  const wallet = kp.publicKey.toBase58();
  const { body: n } = await api("POST", "/auth/nonce", { body: { wallet } });
  const signature = bs58.encode(nacl.sign.detached(new TextEncoder().encode(n.message), kp.secretKey));
  const r = await api("POST", "/auth/verify", { body: { wallet, message: n.message, signature } });
  return { ...r, message: n.message, signature };
}

async function fund(kp, sol) {
  const sig = await conn.requestAirdrop(kp.publicKey, sol * LAMPORTS_PER_SOL);
  const bh = await conn.getLatestBlockhash();
  await conn.confirmTransaction({ signature: sig, ...bh }, "confirmed");
}

async function sendTransfers(payer, transfers) {
  const tx = new Transaction();
  for (const [to, lamports] of transfers) {
    tx.add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: new PublicKey(to), lamports }));
  }
  return sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
}

const cfg = (await api("GET", "/config")).body;
const PLATFORM = cfg.pump.platform_wallet;
const platformShare = (total) => Math.floor((total * cfg.pump.platform_bps) / 10000);
const split = (total) => [total - platformShare(total), platformShare(total)];
console.log(`API ${API} — RPC ${RPC} — platform ${PLATFORM} — split ${cfg.pump.creator_bps}/${cfg.pump.platform_bps}\n`);

// --------------------------------------------------------------------------
console.log("2. Auth wallet + session");
const creator = Keypair.generate();
const pumper = process.env.PUMPER_KEYPAIR
  ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.PUMPER_KEYPAIR, "utf8"))))
  : Keypair.generate();
const outsider = Keypair.generate();

check("nonce rejects an invalid wallet", (await api("POST", "/auth/nonce", { body: { wallet: "nope" } })).status === 400);

const c1 = await signIn(creator);
check("verify returns a Bearer JWT", c1.status === 200 && typeof c1.body.token === "string" && c1.body.token_type === "Bearer");
check("new wallet → needs_pseudo", c1.body.needs_pseudo === true && c1.body.user === null);
const creatorToken = c1.body.token;

const replay = await api("POST", "/auth/verify", {
  body: { wallet: creator.publicKey.toBase58(), message: c1.message, signature: c1.signature },
});
check("a nonce is single-use (replay → 401)", replay.status === 401, JSON.stringify(replay.body));

{
  const wallet = pumper.publicKey.toBase58();
  const { body: n } = await api("POST", "/auth/nonce", { body: { wallet } });
  const forged = bs58.encode(nacl.sign.detached(new TextEncoder().encode(n.message), outsider.secretKey));
  const r = await api("POST", "/auth/verify", { body: { wallet, message: n.message, signature: forged } });
  check("signature by another key → 401", r.status === 401 && r.body.error === "invalid_signature", JSON.stringify(r.body));
  const tampered = n.message.replace("pump.social", "evil.example");
  const { body: n2 } = await api("POST", "/auth/nonce", { body: { wallet } });
  const sig2 = bs58.encode(nacl.sign.detached(new TextEncoder().encode(tampered.replace(n.message.match(/Nonce : (\S+)/)[1], n2.nonce)), pumper.secretKey));
  const r2 = await api("POST", "/auth/verify", { body: { wallet, message: tampered.replace(n.message.match(/Nonce : (\S+)/)[1], n2.nonce), signature: sig2 } });
  check("altered message text → 401", r2.status === 401, JSON.stringify(r2.body));
}

check("GET /me without token → 401", (await api("GET", "/me")).status === 401);
check("GET /me with garbage token → 401", (await api("GET", "/me", { token: "abc.def.ghi" })).status === 401);
const me0 = await api("GET", "/me", { token: creatorToken });
check("GET /me → needs_pseudo", me0.status === 200 && me0.body.needs_pseudo === true);
check("posting before pseudo → 403 pseudo_required",
  (await api("POST", "/posts", { token: creatorToken, body: { texte: "x" } })).body.error === "pseudo_required");
check("invalid pseudo → 400", (await api("POST", "/users", { token: creatorToken, body: { pseudo: "a b" } })).status === 400);
const suffix = Date.now().toString(36).slice(-6);
const creatorPseudo = `creator_${suffix}`;
const u1 = await api("POST", "/users", { token: creatorToken, body: { pseudo: creatorPseudo } });
check("create pseudo → 201", u1.status === 201 && u1.body.user.pseudo === creatorPseudo, JSON.stringify(u1.body));
check("second pseudo for same wallet → 409",
  (await api("POST", "/users", { token: creatorToken, body: { pseudo: `other_${suffix}` } })).status === 409);

const p1 = await signIn(pumper);
const pumperToken = p1.body.token;
const dupe = await api("POST", "/users", { token: pumperToken, body: { pseudo: creatorPseudo.toUpperCase() } });
check("pseudo uniqueness is case-insensitive → 409", dupe.status === 409 && dupe.body.error === "pseudo_taken");
await api("POST", "/users", { token: pumperToken, body: { pseudo: `pumper_${suffix}` } });
const me1 = await api("GET", "/me", { token: pumperToken });
check("after pseudo → needs_pseudo false", me1.body.needs_pseudo === false);

// --------------------------------------------------------------------------
console.log("\n3. Posts + media upload");
check("presign rejects unsupported type", (await api("POST", "/media/presign", { token: creatorToken, body: { content_type: "application/pdf", size: 10 } })).status === 400);
check("presign rejects oversize", (await api("POST", "/media/presign", { token: creatorToken, body: { content_type: "image/png", size: 10 ** 9 } })).status === 400);

const png = Buffer.from(
  "89504E470D0A1A0A0000000D4948445200000001000000010806000000" +
    "1F15C4890000000D49444154789C6360F8CFC0F00F0005FE02FEA7D69A5A0000000049454E44AE426082",
  "hex",
);
const pre = await api("POST", "/media/presign", { token: creatorToken, body: { content_type: "image/png", size: png.length } });
check("presign → form + key under media/<wallet>/", pre.status === 200 && pre.body.media_key.startsWith(`media/${creator.publicKey.toBase58()}/`));

async function uploadForm(upload, bytes, type = "image/png") {
  const fd = new FormData();
  for (const [k, v] of Object.entries(upload.fields)) fd.append(k, v);
  fd.append("file", new Blob([bytes], { type }));
  return fetch(upload.url, { method: "POST", body: fd });
}
const tooBig = await uploadForm(pre.body.upload, Buffer.concat([png, Buffer.alloc(100)]));
check("storage rejects a file larger than declared", tooBig.status >= 400, String(tooBig.status));
const up = await uploadForm(pre.body.upload, png);
check("direct browser-style upload to MinIO (presigned POST)", up.status === 204 || up.status === 201, String(up.status));

const post = await api("POST", "/posts", { token: creatorToken, body: { texte: "Premier post avec image #e2e", media_key: pre.body.media_key } });
check("create post with media → 201", post.status === 201 && post.body.post.media_type === "image", JSON.stringify(post.body));
const created = new Date(post.body.post.created_at).getTime();
const expires = new Date(post.body.post.duration_expires_at).getTime();
check("initial expiry = now + 24h", Math.abs(expires - created - 24 * 3600_000) < 5000);
const media = await fetch(post.body.post.media_url);
check("media URL is publicly readable", media.status === 200 && Buffer.from(await media.arrayBuffer()).equals(png));
check("media key cannot be reused", (await api("POST", "/posts", { token: creatorToken, body: { texte: "x", media_key: pre.body.media_key } })).status === 400);
{
  const pre2 = await api("POST", "/media/presign", { token: creatorToken, body: { content_type: "image/png", size: png.length } });
  await uploadForm(pre2.body.upload, png);
  const steal = await api("POST", "/posts", { token: pumperToken, body: { texte: "x", media_key: pre2.body.media_key } });
  check("cannot attach another user's upload", steal.status === 400);
}
check("empty text → 400", (await api("POST", "/posts", { token: creatorToken, body: { texte: "   " } })).status === 400);
const postId = post.body.post.id;
for (let i = 0; i < 3; i++) await api("POST", "/posts", { token: creatorToken, body: { texte: `texte seul ${i}` } });

const f1 = await api("GET", "/feed?limit=2");
const f2 = await api("GET", `/feed?limit=2&cursor=${f1.body.next_cursor}`);
check("feed newest first + cursor pagination", f1.body.posts.length === 2 && f2.body.posts.length === 2 && f1.body.posts[0].created_at >= f2.body.posts[0].created_at && f2.body.posts.every((p) => !f1.body.posts.some((q) => q.id === p.id)));
check("invalid cursor → 400", (await api("GET", "/feed?cursor=bogus")).status === 400);

// --------------------------------------------------------------------------
console.log("\n4. Pump + on-chain verification");
if (!process.env.PUMPER_KEYPAIR) await fund(pumper, 5);
// The creator needs a little SOL ("signed by someone else" case + a self-pump);
// funded from the pumper so a single funded wallet is enough on devnet.
await sendTransfers(pumper, [[creator.publicKey.toBase58(), 0.3 * LAMPORTS_PER_SOL]]);
const pumpBody = (sig, amount) => ({ token: pumperToken, body: { post_id: postId, tx_signature: sig, amount_sol: amount } });
const CREATOR = creator.publicKey.toBase58();

const total = 0.1 * LAMPORTS_PER_SOL;
const [c70, p30] = split(total);
const goodSig = await sendTransfers(pumper, [[CREATOR, c70], [PLATFORM, p30]]);

const mismatch = await api("POST", "/pumps", pumpBody(goodSig, "0.2"));
check("declared amount ≠ on-chain → 422 amount_mismatch", mismatch.status === 422 && mismatch.body.error === "amount_mismatch", JSON.stringify(mismatch.body));
const ok = await api("POST", "/pumps", pumpBody(goodSig, "0.1"));
check("valid 70/30 tx → 201", ok.status === 201, JSON.stringify(ok.body));
check("recorded amounts come from the chain", ok.body.pump?.creator_amount_sol === "0.070000000" && ok.body.pump?.platform_amount_sol === "0.030000000");
const exp1 = new Date(ok.body.post.duration_expires_at).getTime();
check("expiry extended per tiers (0.1 SOL → +2.4h)", Math.abs(exp1 - created - 26.4 * 3600_000) < 5000, `${(exp1 - created) / 3600_000}h`);
const replayPump = await api("POST", "/pumps", pumpBody(goodSig, "0.1"));
check("same tx again → 409 (anti-replay)", replayPump.status === 409);

const badSplit = await sendTransfers(pumper, [[CREATOR, total / 2], [PLATFORM, total / 2]]);
check("50/50 split → 422 split_mismatch", (await api("POST", "/pumps", pumpBody(badSplit, "0.1"))).body.error === "split_mismatch");

const elsewhere = await sendTransfers(pumper, [[CREATOR, c70], [Keypair.generate().publicKey.toBase58(), p30]]);
check("30% to another wallet → 422 unexpected_transfer", (await api("POST", "/pumps", pumpBody(elsewhere, "0.1"))).body.error === "unexpected_transfer");

const notMine = await sendTransfers(creator, [[PLATFORM, 10_000_000]]);
check("tx signed by someone else → 422 wrong_sender", (await api("POST", "/pumps", pumpBody(notMine, "0.01"))).body.error === "wrong_sender");

const onlyPlatform = await sendTransfers(pumper, [[PLATFORM, p30]]);
check("platform share only → 422", (await api("POST", "/pumps", pumpBody(onlyPlatform, "0.03"))).status === 422);

const fakeSig = bs58.encode(Buffer.alloc(64, 7));
const nf = await api("POST", "/pumps", pumpBody(fakeSig, "0.1"));
check("unknown signature → 422 tx_not_found", nf.status === 422 && nf.body.error === "tx_not_found", JSON.stringify(nf.body));
check("malformed signature → 400", (await api("POST", "/pumps", pumpBody("abc", "0.1"))).status === 400);
check("pump without auth → 401", (await api("POST", "/pumps", { body: { post_id: postId, tx_signature: goodSig, amount_sol: "0.1" } })).status === 401);

// A second pump: 1.5 SOL (crosses the 1 SOL tier).
const t2 = 1.5 * LAMPORTS_PER_SOL;
const [c2, pl2] = split(t2);
const sig2 = await sendTransfers(pumper, [[CREATOR, c2], [PLATFORM, pl2]]);
const ok2 = await api("POST", "/pumps", pumpBody(sig2, 1.5));
check("second pump (number amount) → 201", ok2.status === 201, JSON.stringify(ok2.body));
check("post total = 1.6 SOL", ok2.body.post?.total_pumped_sol === "1.600000000");
const exp2 = new Date(ok2.body.post.duration_expires_at).getTime();
// 24h + 1 SOL × 24h + 0.6 SOL × 12h = 55.2h
check("expiry = 24 + 24 + 7.2 = 55.2h", Math.abs(exp2 - created - 55.2 * 3600_000) < 5000, `${(exp2 - created) / 3600_000}h`);
const detail = await api("GET", `/posts/${postId}`);
check("post detail lists its 2 pumps", detail.body.pumps.length === 2 && detail.body.post.total_pumped_sol === "1.600000000");

// --------------------------------------------------------------------------
console.log("\n6. Leaderboards");
const lbAll = await api("GET", "/leaderboard/posts?period=all");
const mine = lbAll.body.items.find((i) => i.post.id === postId);
check("posts · all includes the post with 1.6 SOL", mine?.total_sol === "1.600000000");
const lb24 = await api("GET", "/leaderboard/posts?period=24h&scope=world");
check("posts · 24h includes it (summed from pumps)", lb24.body.items.some((i) => i.post.id === postId && i.total_sol === "1.600000000"));
const cr = await api("GET", "/leaderboard/creators?period=7d");
const crMine = cr.body.items.find((i) => i.user.wallet === CREATOR);
check("creators · 7d: creator received 70% = 1.12 SOL", crMine?.total_sol === "1.120000000", JSON.stringify(crMine));
const crAll = await api("GET", "/leaderboard/creators?period=all");
check("creators · all = same (counter kept in sync)", crAll.body.items.find((i) => i.user.wallet === CREATOR)?.total_sol === "1.120000000");
const fr = await api("GET", "/leaderboard/posts?period=all&scope=country");
check("scope=country without ?country uses IP-derived country", fr.body.country !== undefined, JSON.stringify(fr.body.country));
const us = await api("GET", "/leaderboard/posts?period=30d&scope=country&country=ZZ");
check("unknown country → empty list", us.status === 200 && us.body.items.length === 0);
{
  const seen = [];
  let cursor = null;
  for (let i = 0; i < 50; i++) {
    const r = await api("GET", `/leaderboard/posts?period=all&limit=1${cursor ? `&cursor=${cursor}` : ""}`);
    seen.push(...r.body.items.map((x) => x.post.id));
    cursor = r.body.next_cursor;
    if (!cursor) break;
  }
  const full = (await api("GET", "/leaderboard/posts?period=all&limit=50")).body.items.map((x) => x.post.id);
  check("cursor pages of 1 == single page (no dup/skip)", JSON.stringify(seen) === JSON.stringify(full), `${seen.length} vs ${full.length}`);
}

// --------------------------------------------------------------------------
console.log("\n7. Pump product rules");
const tokenFor = (kp) => (kp === creator ? creatorToken : pumperToken);
async function pumpFlow(kp, targetPostId, sol, { prepare = true } = {}) {
  // What the UI does: prepare (server check) → sign/send → record.
  let intentId = null;
  if (prepare) {
    const pre = await api("POST", "/pumps/prepare", { token: tokenFor(kp), body: { post_id: targetPostId, amount_sol: String(sol) } });
    if (pre.status !== 200) return { prepare: pre };
    intentId = pre.body.intent_id;
  }
  const lamports = Math.round(sol * LAMPORTS_PER_SOL);
  const [c, p] = split(lamports);
  const sig = await sendTransfers(kp, [[CREATOR, c], [PLATFORM, p]]);
  const rec = await api("POST", "/pumps", {
    token: tokenFor(kp),
    body: { post_id: targetPostId, tx_signature: sig, amount_sol: String(sol), ...(intentId ? { intent_id: intentId } : {}) },
  });
  return { intentId, sig, rec };
}
const newPost = async (texte) => (await api("POST", "/posts", { token: creatorToken, body: { texte } })).body.post.id;

// Rule 1 — self-pump allowed and flagged.
{
  const self = await pumpFlow(creator, postId, 0.1);
  check("R1 self-pump is allowed → 201", self.rec?.status === 201, JSON.stringify(self.rec?.body ?? self.prepare?.body));
  check("R1 self-pump flagged is_self_pump=true", self.rec?.body.pump?.is_self_pump === true);
  const d = await api("GET", `/posts/${postId}`);
  const mine = d.body.pumps.find((p) => p.tx_signature === self.sig);
  const others = d.body.pumps.filter((p) => p.tx_signature !== self.sig);
  check("R1 post detail: self-pump flagged, other pumps not", mine?.is_self_pump === true && others.every((p) => p.is_self_pump === false));
  check("R1 self-pump counts in the post total (1.6 + 0.1)", d.body.post.total_pumped_sol === "1.700000000");
  const lb = await api("GET", "/leaderboard/posts?period=24h&limit=50");
  check("R1 self-pump counts in the leaderboard", lb.body.items.find((i) => i.post.id === postId)?.total_sol === "1.700000000");
}

// Rule 3 — minimum pump.
{
  const cfgNow = (await api("GET", "/config")).body;
  check("R3 GET /config exposes min_pump_sol = 0.005", cfgNow.pump.min_pump_sol === "0.005000000");
  const pre = await api("POST", "/pumps/prepare", { token: pumperToken, body: { post_id: postId, amount_sol: "0.004" } });
  check("R3 prepare 0.004 SOL → 400 below_min_pump (nothing signed)", pre.status === 400 && pre.body.error === "below_min_pump", JSON.stringify(pre.body));
  check("R3 clear message", /Minimum 0,005 SOL/.test(pre.body.message ?? ""));
  const before = (await api("GET", `/posts/${postId}`)).body.pumps.length;
  const bypass = await pumpFlow(pumper, postId, 0.004, { prepare: false });
  check("R3 front bypassed (real 0.004 SOL tx) → server still refuses", bypass.rec.status === 400 && bypass.rec.body.error === "below_min_pump");
  check("R3 …and it is not recorded", (await api("GET", `/posts/${postId}`)).body.pumps.length === before);
  const ok = await api("POST", "/pumps/prepare", { token: pumperToken, body: { post_id: postId, amount_sol: "0.005" } });
  check("R3 exactly 0.005 SOL is accepted", ok.status === 200);
}

// Rule 2 — needs direct DB access to make posts expire (time travel) and the
// purge CLI. Set E2E_DATABASE_URL (e.g. postgres://pump:<password>@localhost:5432/pump).
if (!process.env.E2E_DATABASE_URL) {
  console.log("  (rule 2 checks skipped: set E2E_DATABASE_URL to run them)");
} else {
  const { default: postgres } = await import("postgres");
  const { execSync } = await import("node:child_process");
  const db = postgres(process.env.E2E_DATABASE_URL, { onnotice: () => {} });
  const purgeCmd = process.env.E2E_PURGE_CMD ?? "docker compose exec -T api node dist/cli/purge.js";
  const runPurgeNow = () => {
    const out = execSync(purgeCmd, { cwd: new URL("../..", import.meta.url), encoding: "utf8" });
    return JSON.parse(out.slice(out.indexOf("{\n")));
  };
  // A post created 30h ago that expired 6h ago, never pumped (not in the kept top N).
  const expire = (id) => db`update posts set created_at = now() - interval '30 hours',
                                              duration_expires_at = now() - interval '6 hours' where id = ${id}`;

  // 2.2 — expired post: minimum to save it, enforced before signing.
  const p2 = await newPost("post expiré à sauver #rule2");
  await expire(p2);
  const quote = (await api("GET", `/posts/${p2}/pump-quote`)).body;
  const required = Number(quote.required_min_sol);
  check("R2 quote: status expired + minimum to save", quote.status === "expired" && required > 0.29 && required < 0.31, JSON.stringify(quote));
  const low = await api("POST", "/pumps/prepare", { token: pumperToken, body: { post_id: p2, amount_sol: "0.1" } });
  check("R2 prepare below the save minimum → 422 with the new minimum", low.status === 422 && low.body.error === "amount_too_low_to_save" && Number(low.body.required_min_sol) > 0.29, JSON.stringify(low.body));
  check("R2 message: « Il faut au moins X SOL pour le sauver »", /Ce post est expiré\. Il faut au moins [\d,]+ SOL pour le sauver/.test(low.body.message));

  // 2.4 — a reservation protects the post from the purge while the pump confirms.
  const pre = await api("POST", "/pumps/prepare", { token: pumperToken, body: { post_id: p2, amount_sol: String(required) } });
  check("R2 prepare with the quoted minimum → reservation", pre.status === 200 && !!pre.body.intent_id, JSON.stringify(pre.body));
  const purge1 = runPurgeNow();
  const [afterPurge] = await db`select deleted_at from posts where id = ${p2}`;
  check("R2 purge during an in-flight pump defers the post", afterPurge.deleted_at === null && purge1.postsDeferred >= 1, JSON.stringify(purge1));
  const lamports = Math.round(required * LAMPORTS_PER_SOL);
  const [c2, pl2] = split(lamports);
  const sig2 = await sendTransfers(pumper, [[CREATOR, c2], [PLATFORM, pl2]]);
  const rec2 = await api("POST", "/pumps", { token: pumperToken, body: { post_id: p2, tx_signature: sig2, amount_sol: String(required), intent_id: pre.body.intent_id } });
  check("R2 pump recorded → post saved", rec2.status === 201 && rec2.body.post_purged === false);
  const savedUntil = new Date(rec2.body.post?.duration_expires_at).getTime();
  check("R2 saved post lives ≥ 1h more", savedUntil >= Date.now() + 59 * 60_000, rec2.body.post?.duration_expires_at);
  const [intentRow] = await db`select resolved_at, pump_id from pump_intents where id = ${pre.body.intent_id}`;
  check("R2 reservation closed by the pump", intentRow.resolved_at !== null && intentRow.pump_id === rec2.body.pump.id);
  runPurgeNow();
  check("R2 saved post survives the next purge", (await db`select deleted_at from posts where id = ${p2}`)[0].deleted_at === null);

  // Edge case — modal opened on an expired post, then the post is purged
  // before the user confirms: refused BEFORE any signature.
  const p3 = await newPost("post purgé pendant que la modale est ouverte #rule2");
  await expire(p3);
  const q3 = (await api("GET", `/posts/${p3}/pump-quote`)).body;
  check("R2 edge: modal opens on an expired post", q3.status === "expired");
  runPurgeNow(); // no reservation yet → purged
  check("R2 edge: post purged meanwhile", (await db`select deleted_at from posts where id = ${p3}`)[0].deleted_at !== null);
  const late = await api("POST", "/pumps/prepare", { token: pumperToken, body: { post_id: p3, amount_sol: q3.required_min_sol } });
  check("R2 edge: prepare → 409 post_deleted, no transaction to sign", late.status === 409 && late.body.error === "post_deleted", JSON.stringify(late.body));
  check("R2 edge: clear message", /supprimé/.test(late.body.message));
  check("R2 edge: quote now says deleted (no Pump button)", (await api("GET", `/posts/${p3}/pump-quote`)).body.status === "deleted");

  // 2.4 fallback — a client that skipped the pre-check pays a purged post: the
  // money moved, so the pump is recorded and flagged for a manual refund.
  const bypass = await pumpFlow(pumper, p3, 0.01, { prepare: false });
  check("R2 pump landing on a purged post is recorded + flagged", bypass.rec.status === 201 && bypass.rec.body.post_purged === true);
  const [flag] = await db`select recorded_after_purge from pumps where tx_signature = ${bypass.sig}`;
  check("R2 refund flag stored (recorded_after_purge)", flag.recorded_after_purge === true);

  // A reservation that expires without a recorded pump is flagged for a
  // manual check, and no longer blocks the purge.
  const p4 = await newPost("réservation abandonnée #rule2");
  await expire(p4);
  const pre4 = await api("POST", "/pumps/prepare", { token: pumperToken, body: { post_id: p4, amount_sol: "0.5" } });
  await db`update pump_intents set expires_at = now() - interval '1 second' where id = ${pre4.body.intent_id}`;
  const purge4 = runPurgeNow();
  const [i4] = await db`select flagged_at from pump_intents where id = ${pre4.body.intent_id}`;
  check("R2 abandoned reservation: post purged + intent flagged", (await db`select deleted_at from posts where id = ${p4}`)[0].deleted_at !== null && i4.flagged_at !== null && purge4.intentsFlagged >= 1, JSON.stringify(purge4));
  await db.end();
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
console.log(JSON.stringify({ postId, creator: CREATOR, pumper: pumper.publicKey.toBase58() }));
process.exit(failures ? 1 : 0);
