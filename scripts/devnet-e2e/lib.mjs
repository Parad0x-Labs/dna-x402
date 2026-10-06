// Shared helpers for the devnet / local-validator end-to-end scripts.
//
// Every outcome is graded from the ledger: a transaction is sent, confirmed,
// then read back with getTransaction (err, logs, compute units, fee). Negative
// cases are sent with preflight off so the failure lands on chain and is read
// back the same way.
//
// Env:
//   RPC_URL       cluster RPC (required)
//   EVIDENCE_DIR  directory for the evidence JSON (default ./evidence)
//   AIRDROP=1     fund wallets with requestAirdrop (local validator only)

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createPrivateKey, createPublicKey, sign as edSign } from "node:crypto";
import { join } from "node:path";

export const RPC_URL = process.env.RPC_URL;
if (!RPC_URL) throw new Error("RPC_URL is required");
export const EVIDENCE_DIR = process.env.EVIDENCE_DIR ?? "./evidence";
export const AIRDROP = process.env.AIRDROP === "1";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── base58 / bytes ──────────────────────────────────────────────────────────

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function b58encode(b) {
  let n = 0n;
  for (const x of b) n = (n << 8n) | BigInt(x);
  let s = "";
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const x of b) {
    if (x !== 0) break;
    s = "1" + s;
  }
  return s;
}
export function b58decode(s, len = 32) {
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error("bad base58");
    n = n * 58n + BigInt(i);
  }
  const out = new Uint8Array(len);
  for (let i = len - 1; i >= 0; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}
export const k58 = (k) => (typeof k === "string" ? k : b58encode(k));

// ── keys ────────────────────────────────────────────────────────────────────

const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/** Loads a Solana CLI keypair file. The secret never leaves this object. */
export function loadKey(path) {
  const secret = Uint8Array.from(JSON.parse(readFileSync(path, "utf8")));
  if (secret.length !== 64) throw new Error(`${path}: not a 64-byte keypair`);
  return keyFromSecret(secret);
}

/** Signer from a 64-byte secret key (seed || public key). */
export function keyFromSecret(secret) {
  const priv = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, Buffer.from(secret.subarray(0, 32))]), format: "der", type: "pkcs8" });
  const spki = createPublicKey(priv).export({ format: "der", type: "spki" });
  const publicKey = Uint8Array.from(spki.subarray(spki.length - 32));
  return {
    publicKey,
    pk: b58encode(publicKey),
    sign: (m) => Uint8Array.from(edSign(null, m, priv)),
    secretKey: secret,
  };
}

/** A fresh in-memory signer (never written to disk). */
export function freshKey() {
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const priv = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, Buffer.from(seed)]), format: "der", type: "pkcs8" });
  const spki = createPublicKey(priv).export({ format: "der", type: "spki" });
  const publicKey = Uint8Array.from(spki.subarray(spki.length - 32));
  const secretKey = new Uint8Array(64);
  secretKey.set(seed, 0);
  secretKey.set(publicKey, 32);
  return { publicKey, pk: b58encode(publicKey), sign: (m) => Uint8Array.from(edSign(null, m, priv)), secretKey };
}

// ── JSON-RPC ────────────────────────────────────────────────────────────────

let rpcId = 0;
export async function rpc(method, params = []) {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(RPC_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
      });
      if (r.status === 429 || r.status >= 500) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      if (j.error) {
        const e = new Error(`${method}: ${j.error.message}`);
        e.rpc = j.error;
        throw e;
      }
      return j.result;
    } catch (e) {
      if (e.rpc || attempt >= 6) throw e;
      await sleep(400 * (attempt + 1));
    }
  }
}

export const getSlot = async (commitment = "confirmed") => BigInt(await rpc("getSlot", [{ commitment }]));
export async function getBalance(k) {
  return BigInt((await rpc("getBalance", [k58(k), { commitment: "confirmed" }])).value);
}
export async function getAccount(k) {
  const res = await rpc("getAccountInfo", [k58(k), { encoding: "base64", commitment: "confirmed" }]);
  if (!res?.value) return null;
  return { lamports: BigInt(res.value.lamports), owner: res.value.owner, data: Uint8Array.from(Buffer.from(res.value.data[0], "base64")) };
}
export async function latestBlockhash() {
  const r = await rpc("getLatestBlockhash", [{ commitment: "confirmed" }]);
  return { str: r.value.blockhash, bytes: b58decode(r.value.blockhash), lastValidBlockHeight: r.value.lastValidBlockHeight };
}
export async function rentExempt(len) {
  return BigInt(await rpc("getMinimumBalanceForRentExemption", [len, { commitment: "confirmed" }]));
}

/** Waits until the cluster's confirmed slot is >= `slot`. */
export async function waitSlot(slot, label = "") {
  const t0 = Date.now();
  let last = 0n;
  for (;;) {
    const s = await getSlot();
    if (s >= slot) return s;
    if (s - last >= 500n || last === 0n) {
      console.log(`  waiting for slot ${slot}${label ? ` (${label})` : ""}: at ${s}, ${(Date.now() - t0) / 1000}s`);
      last = s;
    }
    await sleep(Number(slot - s) > 40 ? 2000 : 400);
  }
}

export async function airdrop(k, lamports) {
  if (!AIRDROP) throw new Error("airdrop disabled (set AIRDROP=1 on a local validator)");
  const sig = await rpc("requestAirdrop", [k58(k), Number(lamports), { commitment: "confirmed" }]);
  await confirm(sig);
  return sig;
}

/** Transfers from a funded wallet with a legacy system transfer. */
export async function fund(from, to, lamports) {
  const data = new Uint8Array(12);
  new DataView(data.buffer).setUint32(0, 2, true);
  new DataView(data.buffer).setBigUint64(4, BigInt(lamports), true);
  const ix = { programId: new Uint8Array(32), keys: [{ pubkey: from.publicKey, isSigner: true, isWritable: true }, { pubkey: b58decode(k58(to)), isSigner: false, isWritable: true }], data };
  return sendLegacy(from, [ix], []);
}

// ── transactions ────────────────────────────────────────────────────────────

const shortvec = (n) => {
  const out = [];
  for (;;) {
    let b = n & 0x7f;
    n >>= 7;
    if (n) b |= 0x80;
    out.push(b);
    if (!n) return out;
  }
};
const hexOf = (k) => Buffer.from(k).toString("hex");
const cmp = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));

/** Normalises an instruction whose keys may be base58 strings (fair-draw SDK) or bytes. */
export function normIx(ix) {
  return {
    programId: typeof ix.programId === "string" ? b58decode(ix.programId) : ix.programId,
    keys: ix.keys.map((k) => ({ pubkey: typeof k.pubkey === "string" ? b58decode(k.pubkey) : k.pubkey, isSigner: k.isSigner, isWritable: k.isWritable })),
    data: ix.data,
  };
}

/** SetComputeUnitLimit instruction (ComputeBudget tag 2). */
export function cuLimitIx(units) {
  const data = new Uint8Array(5);
  data[0] = 2;
  new DataView(data.buffer).setUint32(1, units, true);
  return { programId: b58decode("ComputeBudget111111111111111111111111111111"), keys: [], data };
}

/** Legacy transaction: serialise, sign, send. Returns the signature. */
export async function sendLegacy(payer, ixsIn, signers = [], opts = {}) {
  const ixs = ixsIn.map(normIx);
  if (opts.cuLimit) ixs.unshift(cuLimitIx(opts.cuLimit));
  const meta = new Map();
  const touch = (k, s, w) => {
    const h = hexOf(k);
    const m = meta.get(h) ?? { key: k, signer: false, writable: false };
    m.signer ||= s;
    m.writable ||= w;
    meta.set(h, m);
  };
  for (const ix of ixs) {
    touch(ix.programId, false, false);
    for (const a of ix.keys) touch(a.pubkey, a.isSigner, a.isWritable);
  }
  meta.delete(hexOf(payer.publicKey));
  const rest = [...meta.values()].sort((a, b) => cmp(a.key, b.key));
  const ws = rest.filter((m) => m.signer && m.writable), rs = rest.filter((m) => m.signer && !m.writable);
  const wn = rest.filter((m) => !m.signer && m.writable), rn = rest.filter((m) => !m.signer && !m.writable);
  const keys = [payer.publicKey, ...ws.map((m) => m.key), ...rs.map((m) => m.key), ...wn.map((m) => m.key), ...rn.map((m) => m.key)];
  const idx = new Map(keys.map((k, i) => [hexOf(k), i]));
  const bh = opts.blockhash ?? (await latestBlockhash());
  const parts = [Uint8Array.of(1 + ws.length + rs.length, rs.length, rn.length), Uint8Array.from(shortvec(keys.length)), ...keys, bh.bytes, Uint8Array.from(shortvec(ixs.length))];
  for (const ix of ixs) {
    parts.push(Uint8Array.of(idx.get(hexOf(ix.programId))), Uint8Array.from(shortvec(ix.keys.length)), Uint8Array.from(ix.keys.map((a) => idx.get(hexOf(a.pubkey)))), Uint8Array.from(shortvec(ix.data.length)), ix.data);
  }
  const msg = Buffer.concat(parts.map((p) => Buffer.from(p)));
  const all = [payer, ...signers];
  const nSig = 1 + ws.length + rs.length;
  const sigs = [];
  for (let i = 0; i < nSig; i++) {
    const s = all.find((x) => cmp(x.publicKey, keys[i]) === 0);
    if (!s) throw new Error(`missing signer ${b58encode(keys[i])}`);
    sigs.push(Buffer.from(s.sign(msg)));
  }
  const tx = Buffer.concat([Buffer.from(shortvec(nSig)), ...sigs, msg]);
  if (tx.length > 1232) throw new Error(`legacy tx too large: ${tx.length} B`);
  return sendRaw(tx, b58encode(sigs[0]), opts);
}

/** Sends serialised bytes; `sig` is the fee payer signature (base58). */
export async function sendRaw(tx, sig, opts = {}) {
  const res = await rpc("sendTransaction", [Buffer.from(tx).toString("base64"), { encoding: "base64", skipPreflight: !!opts.skipPreflight, preflightCommitment: "confirmed", maxRetries: 5 }]);
  if (sig && res !== sig) throw new Error(`signature mismatch: ${res} vs ${sig}`);
  await confirm(res, opts.timeoutMs ?? 60_000);
  return res;
}

export async function confirm(sig, timeoutMs = 60_000) {
  const t0 = Date.now();
  for (;;) {
    const r = await rpc("getSignatureStatuses", [[sig], { searchTransactionHistory: false }]);
    const s = r.value[0];
    if (s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")) return s;
    if (Date.now() - t0 > timeoutMs) throw new Error(`not confirmed in ${timeoutMs} ms: ${sig}`);
    await sleep(500);
  }
}

/** Reads the transaction back from the ledger and grades it. */
export async function readTx(sig) {
  for (let i = 0; i < 40; i++) {
    let tx = null;
    try {
      tx = await rpc("getTransaction", [sig, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 1 }]);
    } catch (e) {
      // Older RPCs do not take version 1; retry with 0.
      tx = await rpc("getTransaction", [sig, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
    }
    if (tx) {
      const logs = tx.meta?.logMessages ?? [];
      return {
        signature: sig,
        slot: tx.slot,
        version: tx.version ?? "legacy",
        err: tx.meta?.err ?? null,
        fee: tx.meta?.fee ?? null,
        cu: tx.meta?.computeUnitsConsumed ?? null,
        ixCu: topLevelCu(logs),
        logs,
      };
    }
    await sleep(500);
  }
  throw new Error(`getTransaction returned null for ${sig}`);
}

/** Compute units of each top-level program invocation, in order, from the logs. */
export function topLevelCu(logs) {
  const out = [];
  let depth = 0;
  for (const l of logs) {
    const inv = /^Program (\S+) invoke \[(\d+)\]/.exec(l);
    if (inv) {
      depth = Number(inv[2]);
      continue;
    }
    const used = /^Program (\S+) consumed (\d+) of (\d+) compute units/.exec(l);
    if (used && depth === 1) out.push({ program: used[1], cu: Number(used[2]) });
    if (/^Program (\S+) (success|failed)/.test(l)) depth = Math.max(0, depth - 1);
  }
  return out;
}

/** Custom error code of a failed transaction, if any. */
export function customCode(err) {
  const ie = err?.InstructionError;
  if (!ie) return null;
  const c = ie[1]?.Custom;
  return typeof c === "number" ? c : null;
}

// ── evidence ────────────────────────────────────────────────────────────────

export class Evidence {
  constructor(name, meta = {}) {
    this.name = name;
    this.doc = { program: name, rpc: RPC_URL.replace(/api-key=[^&]+/, "api-key=REDACTED"), started: new Date().toISOString(), ...meta, steps: [], checks: [], summary: {} };
    this.failures = 0;
  }
  /** Records a landed transaction. `expect` is "ok" or an error name/code. */
  step(label, g, extra = {}) {
    const e = { label, signature: g.signature, slot: g.slot, version: g.version, err: g.err, fee: g.fee, cu: g.cu, ixCu: g.ixCu, ...extra };
    if (extra.keepLogs || g.err) e.logs = g.logs.slice(-12);
    this.doc.steps.push(e);
    return e;
  }
  check(label, pass, detail = {}) {
    this.doc.checks.push({ label, pass: !!pass, ...detail });
    console.log(`${pass ? "PASS" : "FAIL"} ${label}${Object.keys(detail).length ? " " + JSON.stringify(detail, (_, v) => (typeof v === "bigint" ? v.toString() : v)) : ""}`);
    if (!pass) this.failures++;
    return !!pass;
  }
  save(file) {
    this.doc.finished = new Date().toISOString();
    this.doc.result = this.failures === 0 ? "PASS" : "FAIL";
    this.doc.failures = this.failures;
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    const p = join(EVIDENCE_DIR, file ?? `${this.name}.json`);
    writeFileSync(p, JSON.stringify(this.doc, (_, v) => (typeof v === "bigint" ? v.toString() : v), 1));
    console.log(`evidence: ${p} (${this.doc.result}, ${this.doc.checks.length} checks, ${this.failures} failed)`);
    return p;
  }
}

/** Sends, reads back and records. Returns the graded transaction.
 *  `expect`: "ok", or a custom error code number, or "fail" (any error). */
export async function run(ev, label, sendFn, expect = "ok", extra = {}) {
  let sig;
  try {
    sig = await sendFn();
  } catch (e) {
    ev.check(`${label}: sent`, false, { error: String(e.message ?? e).slice(0, 400) });
    return null;
  }
  const g = await readTx(sig);
  ev.step(label, g, extra);
  if (expect === "ok") ev.check(label, g.err === null, { cu: g.cu, fee: g.fee, err: g.err });
  else if (expect === "fail") ev.check(`${label} (rejected)`, g.err !== null, { err: g.err });
  else ev.check(`${label} (rejected with 0x${expect.toString(16)})`, customCode(g.err) === expect, { err: g.err });
  return g;
}
