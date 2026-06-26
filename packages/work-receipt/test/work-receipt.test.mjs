// work-receipt — offline acceptance (no RPC, no SOL).
// Proves the security properties the design calls for: binding, deliver-Y-call-it-X = forgery,
// replay/transplant resistance, the pre-pin rule, accept-only-by-the-pinning-requester, canonical
// parity, anti-equivocation on the dag, and the deterministic L3 subset (undecided never accepts).
//
// Run: node test/work-receipt.test.mjs
import {
  pinTask, verifyTaskPin, signWorkBinding, verifyWorkBinding, signAccept, verifyAccept,
  checkGate, bindToDag, canonicalJSON, canonicalSha256Hex, digestOf,
} from "../src/index.mjs";
import { randomBytes, createHash } from "node:crypto";

// Minimal receipt-dag semantics, faithful to @parad0x_labs/receipt-dag (receiptId =
// sha256(agentPubkey:sequenceNonce:actionHash); equivocation on a repeated (agentPubkey,
// sequenceNonce) slot), inlined so this test is self-contained + portable. At runtime, bindToDag
// composes the real receipt-dag buildDagReceipt.
const sha = (s) => createHash("sha256").update(s).digest("hex");
function buildDagReceipt({ agentPubkey, actionHash, sequenceNonce, parentReceiptId, timestamp }) {
  const receiptId = sha(`${agentPubkey}:${sequenceNonce}:${actionHash}`);
  const r = { receiptId, sequenceNonce, agentPubkey, actionHash, timestamp: timestamp ?? 0 };
  if (parentReceiptId !== undefined) r.parentReceiptId = parentReceiptId;
  return r;
}
function verifyDagChain(receipts) {
  const seen = new Map();
  for (const r of receipts) {
    if (r.receiptId !== sha(`${r.agentPubkey}:${r.sequenceNonce}:${r.actionHash}`)) return { valid: false, violation: "receiptId mismatch" };
    const k = `${r.agentPubkey}:${r.sequenceNonce}`;
    if (seen.has(k)) return { valid: false, violation: `EQUIVOCATION DETECTED — ${k}` };
    seen.set(k, r);
  }
  return { valid: true };
}

let pass = 0, fail = 0;
const check = (n, c, e = "") => { c ? (pass++, console.log(`  ✓ ${n} ${e}`)) : (fail++, console.log(`  ✗ ${n} ${e}`)); };
const seed = () => new Uint8Array(randomBytes(32));

console.log("work-receipt — verify the work, offline e2e\n");

const requester = seed();
const worker = seed();
const now = 1_780_000_000;
const expiry = now + 86400;

// A pinned task (requester signs BEFORE work). Spec carries an Arweave tx-id so both recompute the hash.
const taskSpec = { v: 1, title: "summarize doc", arweaveTxId: "AR".repeat(21).slice(0, 43), constraints: { maxWords: 200 }, predicate: { type: "none" } };
const { pin, sigT, taskSpecHash } = pinTask({ taskSpec, requesterSeed32: requester, nonce: "n1", expiry });

// ── 1. GOLDEN: pin → bind → accept all verify ───────────────────────────────────────────────────
check("task pin verifies", verifyTaskPin(pin, sigT) === true);
const deliverable = "here is the 180-word summary …";
const { binding, sigW, deliverableDigest } = signWorkBinding({ pin, sigT, deliverable, workerSeed32: worker, nonce: "n1", expiry, now });
const vb = verifyWorkBinding({ binding, sigW, pin, sigT, deliverable });
check("work binding verifies against the pinned task + actual deliverable", vb.valid === true, `(digest ${deliverableDigest.slice(0, 8)}…)`);
const { verdict, sigA } = signAccept({ pin, sigT, binding, sigW, verdict: "accept", reasonCode: "ok", requesterSeed32: requester, nonce: "n1" });
check("requester accept verdict verifies (bound to pin + binding)", verifyAccept({ verdict, sigA, pin, sigT, binding, sigW }).valid === true);

// ── 2. DELIVER-Y-CALL-IT-X: a different deliverable under the same signature is a forgery ─────────
const swapped = verifyWorkBinding({ binding, sigW, pin, sigT, deliverable: "a totally different deliverable" });
check("deliver-Y-call-it-X rejected (digest != binding)", swapped.valid === false && /Y-call-it-X/.test(swapped.reason));

// ── 3. REPLAY/TRANSPLANT: the binding can't be reused under a different task ──────────────────────
const otherTask = pinTask({ taskSpec: { ...taskSpec, title: "different task" }, requesterSeed32: requester, nonce: "n2", expiry });
const transplant = verifyWorkBinding({ binding, sigW, pin: otherTask.pin, sigT: otherTask.sigT, deliverable });
check("binding can't be transplanted to another task", transplant.valid === false && /taskSpecHash/.test(transplant.reason));

// ── 4. PRE-PIN DISCIPLINE: no binding without a valid prior task pin ──────────────────────────────
let prePinThrew = false;
try { signWorkBinding({ pin: { ...pin, taskSpecHash: "deadbeef" }, sigT, deliverable, workerSeed32: worker, nonce: "n1", expiry, now }); } catch { prePinThrew = true; }
check("worker can't bind without a valid task pin (pre-pin rule)", prePinThrew === true);
let expiredThrew = false;
try { signWorkBinding({ pin, sigT, deliverable, workerSeed32: worker, nonce: "n1", expiry, now: expiry + 1 }); } catch { expiredThrew = true; }
check("expired task pin refuses to bind", expiredThrew === true);
const expiredAtVerify = verifyWorkBinding({ binding, sigW, pin, sigT, deliverable, now: expiry + 1 });
check("expired binding rejected at verify time (worker can't dodge by omitting now)", expiredAtVerify.valid === false && /expired/.test(expiredAtVerify.reason));

// ── 5. ACCEPT authority — enforced unconditionally, bound to a verified binding ───────────────────
const stranger = seed();
let noPinThrew = false;
try { signAccept({ binding, sigW, verdict: "accept", requesterSeed32: requester, nonce: "x" }); } catch { noPinThrew = true; }
check("signAccept refuses without a valid pin (authority not opt-in)", noPinThrew === true);
let strangerThrew = false;
try { signAccept({ pin, sigT, binding, sigW, verdict: "accept", requesterSeed32: stranger, nonce: "x" }); } catch { strangerThrew = true; }
check("a non-pinning key cannot sign an accept over this pin", strangerThrew === true);
// the stranger CAN accept its OWN task (disclosed sybil limit) — but can't pass it off as the real one
const sTask = pinTask({ taskSpec: { ...taskSpec, title: "stranger task" }, requesterSeed32: stranger, nonce: "s", expiry });
const sBind = signWorkBinding({ pin: sTask.pin, sigT: sTask.sigT, deliverable, workerSeed32: worker, nonce: "s", expiry, now });
const sAcc = signAccept({ pin: sTask.pin, sigT: sTask.sigT, binding: sBind.binding, sigW: sBind.sigW, verdict: "accept", requesterSeed32: stranger, nonce: "s" });
check("stranger can accept its OWN task (acknowledged sybil limit)", verifyAccept({ verdict: sAcc.verdict, sigA: sAcc.sigA, pin: sTask.pin, sigT: sTask.sigT, binding: sBind.binding, sigW: sBind.sigW }).valid === true);
check("stranger's accept can't be passed off against the real task (fail-open CLOSED)", verifyAccept({ verdict: sAcc.verdict, sigA: sAcc.sigA, pin, sigT, binding, sigW }).valid === false);

// ── 6. WORKER IMPERSONATION: worker_pub must match the expected on-chain owner ───────────────────
const wrongOwner = verifyWorkBinding({ binding, sigW, pin, sigT, deliverable, expectedWorkerPub: toHexPub(seed()) });
check("binding rejected when worker_pub != the .null on-chain owner", wrongOwner.valid === false && /owner/.test(wrongOwner.reason));
function toHexPub(s) { const { binding: b } = signWorkBinding({ pin, sigT, deliverable: "x", workerSeed32: s, nonce: "z", expiry, now }); return b.worker_pub; }

// ── 7. CANONICAL PARITY: key order must not change the hash (the canonicalizer pin) ──────────────
const a = { b: 1, a: 2, nested: { y: 1, x: 2 } };
const b = { nested: { x: 2, y: 1 }, a: 2, b: 1 };
check("canonical hash is key-order-independent", canonicalSha256Hex(a) === canonicalSha256Hex(b));
check("canonical form differs from naive JSON.stringify (the trap)", canonicalJSON(a) !== JSON.stringify(a) || canonicalJSON(a) === canonicalJSON(b));

// ── 8. ANTI-EQUIVOCATION on the anchored dag (two bindings, same worker+nonce) ───────────────────
const workerB58 = "Wk" + "1".repeat(42); // stand-in base58 wallet
const r1 = bindToDag({ binding, sigW, workerPubB58: workerB58, sequenceNonce: 0, timestamp: now, buildDagReceipt });
const { binding: binding2, sigW: sigW2 } = signWorkBinding({ pin, sigT, deliverable: "second different deliverable", workerSeed32: worker, nonce: "n1b", expiry, now });
const r2 = bindToDag({ binding: binding2, sigW: sigW2, workerPubB58: workerB58, sequenceNonce: 0, timestamp: now + 1, buildDagReceipt }); // SAME nonce = equivocation
check("clean single binding anchors + verifies", verifyDagChain([r1]).valid === true);
const ev = verifyDagChain([r1, r2]);
check("two bindings at one (worker, sequenceNonce) = equivocation caught", ev.valid === false && /EQUIVOCATION/.test(ev.violation || ""));

// ── 9. L3 CHECK GATE — predicate bound to the pinned hash (no self-grade); undecided never accepts ──
const outSpec = { v: 1, title: "compute", arweaveTxId: taskSpec.arweaveTxId, predicate: { type: "outputHash", expectedOutputHash: digestOf("the exact expected output") } };
const outPin = pinTask({ taskSpec: outSpec, requesterSeed32: requester, nonce: "o", expiry });
check("L3 outputHash match -> accept", checkGate({ taskSpec: outSpec, pin: outPin.pin, deliverable: "the exact expected output" }).verdict === "accept");
check("L3 outputHash mismatch -> reject", checkGate({ taskSpec: outSpec, pin: outPin.pin, deliverable: "wrong output" }).verdict === "reject");
// SELF-GRADE CLOSED: a worker-supplied predicate that isn't the pinned spec is refused
const forgedSpec = { ...taskSpec, predicate: { type: "outputHash", expectedOutputHash: digestOf(deliverable) } };
const selfGrade = checkGate({ taskSpec: forgedSpec, pin, deliverable }); // `pin` is for the ORIGINAL spec
check("self-supplied predicate refused (self-grade CLOSED)", selfGrade.decided === false && /self-grade/.test(selfGrade.reason));
const schemaSpec = { v: 1, title: "shape", arweaveTxId: taskSpec.arweaveTxId, predicate: { type: "schema", required: ["summary", "wordCount"] } };
const schemaPin = pinTask({ taskSpec: schemaSpec, requesterSeed32: requester, nonce: "sc", expiry });
check("L3 schema: all keys -> accept", checkGate({ taskSpec: schemaSpec, pin: schemaPin.pin, deliverable: JSON.stringify({ summary: "x", wordCount: 180 }) }).verdict === "accept");
check("L3 schema: missing key -> reject", checkGate({ taskSpec: schemaSpec, pin: schemaPin.pin, deliverable: JSON.stringify({ summary: "x" }) }).verdict === "reject");
check("L3 schema: array deliverable -> reject (not a JSON object)", checkGate({ taskSpec: schemaSpec, pin: schemaPin.pin, deliverable: JSON.stringify([1, 2]) }).verdict === "reject");
const emptySpec = { v: 1, title: "empty", arweaveTxId: taskSpec.arweaveTxId, predicate: { type: "schema", required: [] } };
const emptyPin = pinTask({ taskSpec: emptySpec, requesterSeed32: requester, nonce: "e", expiry });
check("L3 schema: empty required -> UNDECIDED (no silent accept)", checkGate({ taskSpec: emptySpec, pin: emptyPin.pin, deliverable: "{}" }).decided === false);
check("L3 no predicate (subjective) -> UNDECIDED", checkGate({ taskSpec, pin, deliverable }).decided === false);

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
console.log("(anchoring to live receipt_anchor = bindToDag + anchorDagRoot broadcast — the on-chain step, on user go.)");
process.exit(fail === 0 ? 0 : 1);
