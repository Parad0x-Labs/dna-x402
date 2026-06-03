// Node test for the Null Resolver codec.
// Run from extensions/null-resolver:  node test/codec.test.js
//
// Verifies the decoder matches the on-chain NullDomain byte layout
// (programs/null_registrar/src/state.rs) — the bug this fix addresses was the
// decoder assuming an 8-byte Anchor discriminator + u32 name length, which made
// it read the content hash from the wrong offset.

const assert = require("assert");
const {
  NULL_DOMAIN_SIZE,
  NULL_DOMAIN_DISC,
  ND_OFF_NAME,
  ND_OFF_CONTENT_HASH,
  base58Encode,
  padName64,
  buildDomainFilters,
  decodeContentHash,
} = require("../codec.js");

let passed = 0;
function check(label, cond) {
  assert.ok(cond, "FAIL: " + label);
  console.log("  ok - " + label);
  passed++;
}

// Build a synthetic on-chain NullDomain account (154 bytes).
function buildAccount(name, ownerByte, contentHash) {
  const buf = new Uint8Array(NULL_DOMAIN_SIZE);
  buf[0] = NULL_DOMAIN_DISC; // disc 'N' @ 0
  buf.set(padName64(name), ND_OFF_NAME); // name[64] @ 1
  buf.fill(ownerByte, 65, 97); // owner[32] @ 65
  buf.set(contentHash, ND_OFF_CONTENT_HASH); // content_hash[32] @ 97
  // registered_at / expires_at / null_paid / bump left zero
  return buf;
}

const toBase64 = (u8) => Buffer.from(u8).toString("base64");

console.log("codec.test.js");

// 1. content hash is read from the CORRECT offset (97)
const ch = new Uint8Array(32);
for (let i = 0; i < 32; i++) ch[i] = i + 1; // 1..32, a distinctive pattern
const acct = buildAccount("parad0x", 0xaa, ch);
const decoded = decodeContentHash(toBase64(acct));
check("decodeContentHash returns 32 bytes", decoded && decoded.length === 32);
check(
  "decodeContentHash reads content_hash at offset 97 exactly",
  decoded && [...decoded].every((b, i) => b === i + 1)
);

// 2. owner bytes (offset 65) are NOT mistaken for the content hash
check(
  "does not return owner bytes (0xAA)",
  decoded && ![...decoded].every((b) => b === 0xaa)
);

// 3. rejects a wrong discriminator
const bad = buildAccount("parad0x", 0xaa, ch);
bad[0] = 0x00;
check("rejects wrong discriminator", decodeContentHash(toBase64(bad)) === null);

// 4. rejects short buffers
check("rejects short buffer", decodeContentHash(toBase64(new Uint8Array(100))) === null);

// 5. padName64 behaviour
check("padName64 pads to 64", padName64("parad0x").length === 64);
check("padName64 null-pads the tail", padName64("ab")[2] === 0 && padName64("ab")[63] === 0);
check("padName64 rejects names > 64 bytes", padName64("x".repeat(65)) === null);

// 6. getProgramAccounts filters select disc + name at the right offsets
const filters = buildDomainFilters("parad0x");
check("filters: dataSize is 154", filters[0].dataSize === NULL_DOMAIN_SIZE);
check("filters: discriminator memcmp at offset 0", filters[1].memcmp.offset === 0);
check("filters: name memcmp at offset 1", filters[2].memcmp.offset === ND_OFF_NAME);
check(
  "filters: name bytes are base58(padded 64-byte name)",
  filters[2].memcmp.bytes === base58Encode(padName64("parad0x"))
);
check("buildDomainFilters rejects oversize names", buildDomainFilters("x".repeat(65)) === null);

// 7. base58 of the content hash (becomes the Arweave tx id) is non-empty
check("base58Encode produces a non-empty id", base58Encode(ch).length > 0);

console.log(`\n${passed} checks passed.`);
