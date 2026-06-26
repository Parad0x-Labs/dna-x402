// @parad0x_labs/work-receipt — verify the WORK, not just the payment.
//
// The missing middle: identity + payment + anchored receipts don't prove the deliverable was
// bound to the task that was asked, or that it's correct. This is the trustless, serverless,
// NON-CUSTODIAL v0 of that, composed from our shipped primitives — no server, no escrow, no new
// trusted party.
//
//   L1 BINDING  — the requester PINS the task (signs taskSpecHash) BEFORE work; the worker signs a
//                 tuple welding {taskSpecHash, deliverableDigest, both pubkeys, nonce, expiry}.
//                 Deliver Y and call it X => the digest changes => the worker signature is a forgery,
//                 not a relabel. Replay to another task => taskSpecHash/nonce changes => it fails.
//   L3 CHECK    — for the deterministic, no-sandbox subset (output-hash match, frozen schema, a
//                 verifiable proof/sig), anyone can re-run the predicate and the requester signs an
//                 accept/reject verdict. Non-deterministic work returns UNDECIDED — never a silent accept.
//   AUDIT       — bindToDag() anchors a canonical actionHash via receipt-dag to live mainnet, giving a
//                 tamper-evident, time-ordered trail. verifyDagChain catches two receipts at the SAME
//                 (worker, sequenceNonce) slot; detecting two CONTRADICTORY bindings for one task
//                 (different nonces) is an application scan over the anchored log — each binding
//                 commits its taskSpecHash, so the evidence is there, but it is not a single
//                 verifyDagChain call (deriving sequenceNonce from taskSpecHash is a follow-up).
//
// HONEST BOUNDARIES (do NOT overclaim): NO fair exchange (a requester can see-then-withhold the
// accept, a worker can withhold bytes — the absence of an accept is a dispute SIGNAL, not a clawback;
// fair exchange is impossible non-custodial with signatures alone — Pagnia–Gärtner). NO subjective
// correctness (agent-as-judge is out). NO dispute RESOLVER — v0 RECORDS conflicting attestations, it
// does not adjudicate. NO sybil resistance (a party can rubber-stamp its own keys — inherited cosign
// limit; needs on-chain-settlement binding or a counterparty-diversity passport, both out).
//
// The signing core mirrors cosign-receipt (ed25519 + a sorted-key canonicalizer), with NEW domain
// separators so a work-binding can never be replayed as a reputation deal.

import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";

export const NULLWORK1 = "NULLWORK1"; // task pin + worker binding
export const NULLACCEPT1 = "NULLACCEPT1"; // requester accept/dispute verdict

const te = new TextEncoder();
const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (h) => Uint8Array.from((h.startsWith("0x") ? h.slice(2) : h).match(/.{2}/g).map((x) => parseInt(x, 16)));
const bytesOf = (x) => (x instanceof Uint8Array ? x : te.encode(typeof x === "string" ? x : canonicalJSON(x)));

/** Sorted-key canonical JSON — the ONE canonicalizer both parties recompute. NEVER plain
 *  JSON.stringify (key order would diverge and break cross-party verification). */
export function canonicalJSON(obj) {
  if (Array.isArray(obj)) return `[${obj.map((x) => canonicalJSON(x === undefined ? null : x)).join(",")}]`;
  if (obj && typeof obj === "object") {
    // drop undefined-valued keys (matching JSON.stringify) so a tuple never serializes the literal
    // `undefined` — that would be invalid JSON and diverge across implementations.
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJSON(obj[k])}`).join(",")}}`;
  }
  return JSON.stringify(obj);
}
/** sha256 hex of the canonical form — used for taskSpecHash AND the receipt-dag actionHash. */
export const canonicalSha256Hex = (obj) => toHex(sha256(te.encode(canonicalJSON(obj))));
/** sha256 hex of raw deliverable bytes (or canonical form of a structured deliverable). */
export const digestOf = (deliverable) => toHex(sha256(bytesOf(deliverable)));

const signBytes = (domain, tuple) => te.encode(domain + canonicalJSON(tuple));
const pubFromSeed = (seed32) => toHex(ed25519.getPublicKey(assertSeed(seed32)));
function assertSeed(seed32) {
  if (!(seed32 instanceof Uint8Array) || seed32.length !== 32) throw new Error("work-receipt: expected a 32-byte ed25519 seed");
  return seed32;
}

// ── 1. TASK PIN (requester, BEFORE any work) ─────────────────────────────────────────────────────
/** Pin a task: hash the spec, sign it. `taskSpec` should include an Arweave tx-id so both sides
 *  recompute the same taskSpecHash from the stored spec. Pinning before work is load-bearing —
 *  it stops a worker from retro-fitting a spec to whatever it produced. */
export function pinTask({ taskSpec, requesterSeed32, nonce, expiry }) {
  const taskSpecHash = canonicalSha256Hex(taskSpec);
  const requester_pub = pubFromSeed(requesterSeed32);
  const pin = { kind: "task", v: 1, taskSpecHash, requester_pub, nonce: String(nonce), expiry: Number(expiry) };
  const sigT = toHex(ed25519.sign(signBytes(NULLWORK1, pin), requesterSeed32));
  return { taskSpecHash, pin, sigT };
}
export function verifyTaskPin(pin, sigT) {
  try {
    return pin && pin.kind === "task" && typeof sigT === "string" &&
      ed25519.verify(fromHex(sigT), signBytes(NULLWORK1, pin), fromHex(pin.requester_pub));
  } catch {
    return false;
  }
}

// ── 2. WORKER BINDING (after work) ───────────────────────────────────────────────────────────────
/** Bind a deliverable to a PINNED task. REFUSES without a valid prior task pin over the same
 *  taskSpecHash (the pre-pin rule), and rejects an expired pin. */
export function signWorkBinding({ pin, sigT, deliverable, workerSeed32, nonce, expiry, now }) {
  if (!verifyTaskPin(pin, sigT)) throw new Error("work-receipt: no valid task pin — refusing to bind (pre-pin discipline)");
  if (pin.expiry && typeof now === "number" && now > pin.expiry) throw new Error("work-receipt: task pin has expired");
  const deliverableDigest = digestOf(deliverable);
  const worker_pub = pubFromSeed(workerSeed32);
  const binding = {
    kind: "work-binding", v: 1,
    taskSpecHash: pin.taskSpecHash,
    deliverableDigest,
    requester_pub: pin.requester_pub,
    worker_pub,
    nonce: String(nonce),
    expiry: Number(expiry),
  };
  const sigW = toHex(ed25519.sign(signBytes(NULLWORK1, binding), workerSeed32));
  return { binding, deliverableDigest, sigW };
}
/** Verify a work binding against the pin and (optionally) the actual deliverable + the worker's
 *  on-chain .null owner. Returns { valid, reason?, ... }. */
export function verifyWorkBinding({ binding, sigW, pin, sigT, deliverable, expectedWorkerPub, now }) {
  try {
    if (!binding || binding.kind !== "work-binding") return { valid: false, reason: "not a work-binding" };
    if (!verifyTaskPin(pin, sigT)) return { valid: false, reason: "invalid task pin" };
    if (binding.taskSpecHash !== pin.taskSpecHash) return { valid: false, reason: "binding taskSpecHash != pinned task" };
    if (binding.requester_pub !== pin.requester_pub) return { valid: false, reason: "binding requester != pinning requester" };
    if (expectedWorkerPub && binding.worker_pub !== expectedWorkerPub) return { valid: false, reason: "worker_pub is not the .null on-chain owner" };
    // Authoritative expiry: enforced at VERIFY time, where the requester/third-party supplies `now`
    // (the worker can't dodge it by omitting `now` at sign time).
    if (binding.expiry && typeof now === "number" && now > binding.expiry) return { valid: false, reason: "binding expired" };
    if (deliverable !== undefined && digestOf(deliverable) !== binding.deliverableDigest) {
      return { valid: false, reason: "deliverable does not match deliverableDigest (deliver-Y-call-it-X)" };
    }
    if (!ed25519.verify(fromHex(sigW), signBytes(NULLWORK1, binding), fromHex(binding.worker_pub))) {
      return { valid: false, reason: "sigW invalid" };
    }
    return { valid: true, taskSpecHash: binding.taskSpecHash, deliverableDigest: binding.deliverableDigest, worker_pub: binding.worker_pub };
  } catch (e) {
    return { valid: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

// ── 3. ACCEPT / DISPUTE (the pinning requester, over a VERIFIED binding) ──────────────────────────
/** The requester that PINNED the task signs an accept/reject verdict over a VALID work-binding.
 *  Authority is unconditional: a valid {pin, sigT} is REQUIRED, the signer must equal the pinning
 *  requester, and the binding must verify under that pin — so the verdict is welded to the exact
 *  {taskSpecHash, deliverableDigest, worker} that was signed. A `reject` is the anchored dispute
 *  SIGNAL (not adjudication). */
export function signAccept({ pin, sigT, binding, sigW, verdict, reasonCode, requesterSeed32, nonce, deliverable, now }) {
  const requester_pub = pubFromSeed(requesterSeed32);
  if (!verifyTaskPin(pin, sigT)) throw new Error("work-receipt: signAccept requires a valid task pin");
  if (pin.requester_pub !== requester_pub) throw new Error("work-receipt: only the pinning requester may accept/dispute");
  const vb = verifyWorkBinding({ binding, sigW, pin, sigT, deliverable, now });
  if (!vb.valid) throw new Error(`work-receipt: cannot accept an invalid binding (${vb.reason})`);
  const v = {
    kind: "accept", v: 1,
    taskSpecHash: binding.taskSpecHash,
    deliverableDigest: binding.deliverableDigest,
    worker_pub: binding.worker_pub,
    requester_pub,
    verdict: verdict === "accept" ? "accept" : "reject",
    reasonCode: String(reasonCode ?? ""),
    nonce: String(nonce),
  };
  const sigA = toHex(ed25519.sign(signBytes(NULLACCEPT1, v), requesterSeed32));
  return { verdict: v, sigA };
}
/** Verify a verdict: it must come from the pinning requester, over a binding that itself verifies
 *  under the same pin, and match that binding's task+digest. All bindings MANDATORY (no opt-in
 *  authority, no fail-open default). Returns { valid, reason?, verdict? }. */
export function verifyAccept({ verdict, sigA, pin, sigT, binding, sigW }) {
  try {
    if (!verdict || verdict.kind !== "accept") return { valid: false, reason: "not an accept verdict" };
    if (!verifyTaskPin(pin, sigT)) return { valid: false, reason: "invalid task pin" };
    if (verdict.requester_pub !== pin.requester_pub) return { valid: false, reason: "verdict not from the pinning requester" };
    const vb = verifyWorkBinding({ binding, sigW, pin, sigT });
    if (!vb.valid) return { valid: false, reason: `invalid binding (${vb.reason})` };
    if (verdict.taskSpecHash !== binding.taskSpecHash || verdict.deliverableDigest !== binding.deliverableDigest) {
      return { valid: false, reason: "verdict does not match the binding" };
    }
    if (!ed25519.verify(fromHex(sigA), signBytes(NULLACCEPT1, verdict), fromHex(verdict.requester_pub))) {
      return { valid: false, reason: "sigA invalid" };
    }
    return { valid: true, verdict: verdict.verdict, taskSpecHash: verdict.taskSpecHash, deliverableDigest: verdict.deliverableDigest };
  } catch (e) {
    return { valid: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

// ── L3 CHECK GATE (deterministic, no-sandbox subset only) ────────────────────────────────────────
/** Run the task's deterministic predicate against the deliverable. The taskSpec MUST be the one
 *  committed at pin time — checkGate re-hashes it and refuses (UNDECIDED) unless it matches
 *  pin.taskSpecHash, so a worker cannot supply its own grading predicate (self-grade). A spec with
 *  no deterministic predicate returns UNDECIDED — never a silent accept (that's L4/out). */
export function checkGate({ taskSpec, pin, deliverable }) {
  if (!pin || typeof pin.taskSpecHash !== "string") {
    return { decided: false, verdict: "undecided", reason: "no pinned taskSpecHash to bind the predicate to" };
  }
  if (canonicalSha256Hex(taskSpec) !== pin.taskSpecHash) {
    return { decided: false, verdict: "undecided", reason: "taskSpec does not match the pinned hash — self-grade refused" };
  }
  const p = taskSpec && taskSpec.predicate;
  if (!p || !p.type || p.type === "none") {
    return { decided: false, verdict: "undecided", reason: "no deterministic predicate — subjective work (L4, out of v0)" };
  }
  if (p.type === "outputHash") {
    if (typeof p.expectedOutputHash !== "string") return { decided: false, verdict: "undecided", reason: "outputHash predicate missing expectedOutputHash" };
    const ok = digestOf(deliverable) === p.expectedOutputHash;
    return { decided: true, verdict: ok ? "accept" : "reject", reason: ok ? "output digest matches the pinned expected hash" : "output digest mismatch" };
  }
  if (p.type === "schema") {
    const required = Array.isArray(p.required) ? p.required : [];
    if (required.length === 0) return { decided: false, verdict: "undecided", reason: "schema predicate has no required keys — nothing to check" };
    let obj;
    try {
      obj = typeof deliverable === "string" ? JSON.parse(deliverable) : deliverable;
    } catch {
      return { decided: true, verdict: "reject", reason: "deliverable is not valid JSON" };
    }
    if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
      return { decided: true, verdict: "reject", reason: "deliverable is not a JSON object" };
    }
    const missing = required.filter((k) => !Object.prototype.hasOwnProperty.call(obj, k)); // OWN keys only
    return { decided: true, verdict: missing.length === 0 ? "accept" : "reject", reason: missing.length === 0 ? "all required keys present" : `missing keys: ${missing.join(",")}` };
  }
  return { decided: false, verdict: "undecided", reason: `unknown predicate type "${p.type}" — treated as undecided` };
}

// ── ANCHOR (compose receipt-dag) ─────────────────────────────────────────────────────────────────
/** Build the receipt-dag entry for a work binding. The actionHash is the CANONICAL sha256 of
 *  {binding, sigW} (never receipt-dag's plain JSON.stringify), so any verifier re-derives the same
 *  hash. `buildDagReceipt` is injected (receipt-dag or null-mcp private-pay); `workerPubB58` is the
 *  worker's Solana wallet (the caller maps worker_pub hex -> base58 and binds it to the .null owner). */
export function bindToDag({ binding, sigW, workerPubB58, sequenceNonce, parentReceiptId, timestamp, buildDagReceipt }) {
  if (typeof buildDagReceipt !== "function") throw new Error("work-receipt: pass buildDagReceipt (from receipt-dag / null-mcp)");
  const actionHash = canonicalSha256Hex({ kind: "work-binding", binding, sigW });
  return buildDagReceipt({ agentPubkey: workerPubB58, actionHash, sequenceNonce, parentReceiptId, timestamp });
}
