#!/usr/bin/env node
// Local, authoritative cross-check: which signing recipe produces a sig that
// OpenSSL (Node crypto, same lib Agave uses) accepts as ECDSA-P256-SHA256 over
// the raw message, in low-S, raw r||s (64 bytes)?

import { p256 } from "@noble/curves/p256";
import { sha256 } from "@noble/hashes/sha256";
import crypto from "node:crypto";

const n = p256.CURVE.n;
const half = n >> 1n;
const msg = Buffer.from("hello-faceid-probe-message-32byte!!", "utf8");

const priv = p256.utils.randomPrivateKey();
const pubU = p256.getPublicKey(priv, false); // 0x04||x||y
const x = Buffer.from(pubU.slice(1, 33));
const y = Buffer.from(pubU.slice(33, 65));

const b64u = (b) => Buffer.from(b).toString("base64url");
const pubKeyObj = crypto.createPublicKey({
  key: { kty: "EC", crv: "P-256", x: b64u(x), y: b64u(y) }, format: "jwk",
});

function sLowBytes(sig64) {
  const s = BigInt("0x" + Buffer.from(sig64.slice(32, 64)).toString("hex"));
  return s <= half;
}
function opensslVerify(sig64) {
  try {
    return crypto.verify("sha256", msg, { key: pubKeyObj, dsaEncoding: "ieee-p1363" }, Buffer.from(sig64));
  } catch { return false; }
}

const modes = {
  "noble prehash:true":      () => p256.sign(msg, priv, { prehash: true }).toCompactRawBytes(),
  "noble sign(sha256(msg))": () => p256.sign(sha256(msg), priv).toCompactRawBytes(),
  "noble sign(msg) raw":     () => p256.sign(msg, priv).toCompactRawBytes(),
};

console.log("mode                       len  lowS  noble.verify  openssl.verify");
for (const [label, fn] of Object.entries(modes)) {
  let sig;
  try { sig = fn(); } catch (e) { console.log(`${label.padEnd(26)} ERR ${e.message}`); continue; }
  const len = sig.length;
  const low = sLowBytes(sig);
  let nobleOk = false;
  try { nobleOk = p256.verify(sig, msg, p256.getPublicKey(priv, true), { prehash: true }); } catch {}
  const osOk = opensslVerify(sig);
  console.log(`${label.padEnd(26)} ${String(len).padEnd(4)} ${String(low).padEnd(5)} ${String(nobleOk).padEnd(13)} ${osOk}`);
}

// Also: sign directly with OpenSSL (ieee-p1363 → raw 64), enforce low-S, check.
const privKeyObj = crypto.createPrivateKey({
  key: { kty: "EC", crv: "P-256", x: b64u(x), y: b64u(y), d: b64u(priv) }, format: "jwk",
});
let osSig = crypto.sign("sha256", msg, { key: privKeyObj, dsaEncoding: "ieee-p1363" });
// normalize to low-S
let s = BigInt("0x" + osSig.slice(32, 64).toString("hex"));
let lowNote = "already-low";
if (s > half) { s = n - s; const sb = Buffer.from(s.toString(16).padStart(64, "0"), "hex"); osSig = Buffer.concat([osSig.slice(0, 32), sb]); lowNote = "flipped-to-low"; }
console.log(`openssl sign (${lowNote})      64   ${sLowBytes(osSig)}  -            ${opensslVerify(osSig)}`);
