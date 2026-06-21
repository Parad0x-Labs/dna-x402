// codec.js — pure, testable helpers for the Null Resolver.
//
// Loaded two ways:
//   • In the MV3 service worker via importScripts("codec.js") — the function
//     declarations become globals in the classic worker scope.
//   • In the Node test suite via require("../codec.js") — exported through the
//     module.exports guard at the bottom.
//
// On-chain NullDomain byte layout (programs/null_registrar/src/state.rs). The
// struct grows append-only across program versions — live mainnet accounts are
// 314 bytes — but the leading fields below are stable, so the resolver relies
// only on this prefix and never on the total account size:
//   disc[1]            @ 0    = 0x4E ('N')
//   name[64]           @ 1    — UTF-8 domain name, null-padded
//   owner[32]          @ 65
//   content_hash[32]   @ 97   — Arweave tx id hash (what .null resolves to)
//   ... additional fields appended after byte 154 in later program versions
// NULL_DOMAIN_SIZE is the v1 baseline / minimum decodable length, NOT the exact
// account size — newer (larger) accounts decode from the same prefix.

const NULL_DOMAIN_SIZE = 154;
const NULL_DOMAIN_DISC = 0x4e; // 'N'
const ND_OFF_NAME = 1;
const ND_OFF_CONTENT_HASH = 97;
const NAME_LEN = 64;

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

// Encode a byte array as base58 (Solana/Bitcoin alphabet).
function base58Encode(bytes) {
  const digits = [0];
  for (let i = 0; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let result = "";
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) result += "1";
  for (let i = digits.length - 1; i >= 0; i--) result += BASE58_ALPHABET[digits[i]];
  return result;
}

// Encode a domain name as the on-chain 64-byte null-padded field value.
// Returns null if the UTF-8 name does not fit in 64 bytes.
function padName64(name) {
  const utf8 = new TextEncoder().encode(name);
  if (utf8.length > NAME_LEN) return null;
  const out = new Uint8Array(NAME_LEN);
  out.set(utf8, 0);
  return out;
}

// Build getProgramAccounts memcmp filters that uniquely select a NullDomain by
// name. Matching the stored bytes directly is exact regardless of how the
// program derives its PDA seed — and avoids client-side Ed25519 PDA derivation,
// which cannot be done correctly in pure JS without a curve library.
//
// No dataSize filter on purpose: the NullDomain struct grows as the program
// appends fields (v1 was 154 bytes, live mainnet accounts are 314), while the
// disc + 64-byte name already match exactly one account. Pinning the size would
// silently match zero accounts after any struct growth.
function buildDomainFilters(name) {
  const padded = padName64(name);
  if (!padded) return null;
  return [
    { memcmp: { offset: 0, bytes: base58Encode(Uint8Array.from([NULL_DOMAIN_DISC])) } },
    { memcmp: { offset: ND_OFF_NAME, bytes: base58Encode(padded) } },
  ];
}

// Extract the 32-byte Arweave content hash from a base64-encoded account blob.
// Returns null if the blob is too short or the discriminator does not match.
function decodeContentHash(base64Data) {
  const raw = Uint8Array.from(atob(base64Data), (c) => c.charCodeAt(0));
  if (raw.length < NULL_DOMAIN_SIZE) return null;
  if (raw[0] !== NULL_DOMAIN_DISC) return null;
  return raw.slice(ND_OFF_CONTENT_HASH, ND_OFF_CONTENT_HASH + 32);
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    NULL_DOMAIN_SIZE,
    NULL_DOMAIN_DISC,
    ND_OFF_NAME,
    ND_OFF_CONTENT_HASH,
    NAME_LEN,
    base58Encode,
    padName64,
    buildDomainFilters,
    decodeContentHash,
  };
}
