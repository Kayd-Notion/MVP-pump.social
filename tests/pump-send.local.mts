// Integration check of lib/pump.ts sendPump against a local validator
// (not part of `npm test`): RPC_URL=http://127.0.0.1:8899 node --import tsx tests/pump-send.local.mts
import assert from "node:assert/strict";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, type Transaction } from "@solana/web3.js";
import { sendPump } from "../src/lib/pump";
import { humanizePumpError } from "../src/lib/pump-errors";

const conn = new Connection(process.env.RPC_URL ?? "http://127.0.0.1:8899", "confirmed");
const platform = Keypair.generate().publicKey.toBase58();

async function fund(kp: Keypair, sol: number) {
  const sig = await conn.requestAirdrop(kp.publicKey, sol * LAMPORTS_PER_SOL);
  const bh = await conn.getLatestBlockhash();
  await conn.confirmTransaction({ signature: sig, ...bh }, "confirmed");
}

/** A wallet that can only sign (like Phantom's signTransaction). */
function signer(kp: Keypair) {
  let calls = 0;
  return {
    get calls() { return calls; },
    signTransaction: async (tx: Transaction) => { calls++; tx.partialSign(kp); return tx; },
  };
}
const noSend = async () => { throw new Error("sendTransaction must not be used"); };
const balance = (who: string | Keypair) => conn.getBalance(typeof who === "string" ? new PublicKey(who) : who.publicKey);

const pumper = Keypair.generate();
const creator = Keypair.generate();
await fund(pumper, 2);
await fund(creator, 1);
const target = { platformWallet: platform, platformBps: 3000 };

// 1. Wallet signs, app broadcasts on its own RPC.
{
  const w = signer(pumper);
  const r = await sendPump({ connection: conn, payer: pumper.publicKey, creatorWallet: creator.publicKey.toBase58(), amountSol: 0.01, target, sendTransaction: noSend, signTransaction: w.signTransaction });
  assert.equal(w.calls, 1);
  assert.equal((await conn.getParsedTransaction(r.signature, { commitment: "confirmed" }))?.meta?.err, null);
  assert.equal(await balance(platform), 3_000_000);
  console.log("✓ sign-only path: pump confirmed on the app's RPC, 70/30 split");
}

// 2. Self-pump through the same path.
{
  const w = signer(creator);
  const before = await balance(creator);
  await sendPump({ connection: conn, payer: creator.publicKey, creatorWallet: creator.publicKey.toBase58(), amountSol: 0.01, target, sendTransaction: noSend, signTransaction: w.signTransaction });
  assert.equal(before - (await balance(creator)), 3_000_000 + 5000); // 30% + fee
  console.log("✓ self-pump: creator only pays the 30% + fee");
}

// 3. Empty wallet: refused by the dry run, the wallet is never asked to sign.
{
  const broke = Keypair.generate();
  const w = signer(broke);
  await assert.rejects(
    sendPump({ connection: conn, payer: broke.publicKey, creatorWallet: creator.publicKey.toBase58(), amountSol: 0.01, target, sendTransaction: noSend, signTransaction: w.signTransaction }),
    (e) => /Solde insuffisant/.test(humanizePumpError(e)),
  );
  assert.equal(w.calls, 0);
  console.log("✓ empty wallet: readable error, wallet never opened");
}

// 4. Rent minimum: readable error, wallet never opened.
{
  const w = signer(pumper);
  await assert.rejects(
    sendPump({ connection: conn, payer: pumper.publicKey, creatorWallet: Keypair.generate().publicKey.toBase58(), amountSol: 0.0007, target, sendTransaction: noSend, signTransaction: w.signTransaction }),
    (e) => /wallets qui le reçoit est vide/.test(humanizePumpError(e)),
  );
  assert.equal(w.calls, 0);
  console.log("✓ rent minimum: readable error, wallet never opened");
}

// 5. Wallet without signTransaction: falls back to the wallet's send.
{
  let used = false;
  const send = async (tx: Transaction, c: Connection) => { used = true; tx.partialSign(pumper); return c.sendRawTransaction(tx.serialize()); };
  await sendPump({ connection: conn, payer: pumper.publicKey, creatorWallet: creator.publicKey.toBase58(), amountSol: 0.01, target, sendTransaction: send });
  assert.ok(used);
  console.log("✓ fallback: wallet sendTransaction still works");
}
console.log("ALL OK");
