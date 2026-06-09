// Reference Poseidon values from circomlibjs (the circuit's exact Poseidon).
// Computes commitment / nullifier / merkle_node EXACTLY as shielded_withdraw_v2.circom does:
//   commitment   = Poseidon([DOMAIN_COMMIT=1, secret, leaf_index])
//   nullifier    = Poseidon([DOMAIN_NULLIF=2, secret, pool_key_field])
//   merkle_node  = Poseidon([left, right])
// Emits each output as a 32-byte BIG-ENDIAN hex string (matches light-poseidon hash_bytes_be).

import { buildPoseidon } from "circomlibjs";

function toBE32Hex(F, el) {
  // F.toObject returns a canonical BigInt in [0, p). Encode big-endian, 32 bytes.
  const x = F.toObject(el);
  let h = x.toString(16);
  if (h.length > 64) throw new Error("field element too large");
  h = h.padStart(64, "0");
  return h;
}

function toDec(F, el) {
  return F.toObject(el).toString(10);
}

const poseidon = await buildPoseidon();
const F = poseidon.F;

const DOMAIN_COMMIT = 1n;
const DOMAIN_NULLIF = 2n;

// Three concrete vector sets. Values are arbitrary but fixed; chosen to be
// non-trivial (not 0/1) so a wrong domain/order can't accidentally pass.
const vectors = [
  {
    name: "vec0",
    secret: 12345678901234567890n,
    leaf_index: 42n,
    pool_key_field: 9876543210987654321n,
    left: 11111111111111111111n,
    right: 22222222222222222222n,
  },
  {
    name: "vec1",
    secret: 1n,
    leaf_index: 0n,
    pool_key_field: 7n,
    left: 1n,
    right: 2n,
  },
  {
    name: "vec2",
    secret: 0x1234567890abcdef1234567890abcdefn,
    leaf_index: 1048575n, // 2^20 - 1, max leaf for depth-20 tree
    pool_key_field: 0xdeadbeefcafebabe0011223344556677n,
    left: 0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaan,
    right: 0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbn,
  },
];

const out = [];
for (const v of vectors) {
  const commitment = poseidon([DOMAIN_COMMIT, v.secret, v.leaf_index]);
  const nullifier = poseidon([DOMAIN_NULLIF, v.secret, v.pool_key_field]);
  const merkle = poseidon([v.left, v.right]);

  out.push({
    name: v.name,
    inputs: {
      secret: v.secret.toString(10),
      leaf_index: v.leaf_index.toString(10),
      pool_key_field: v.pool_key_field.toString(10),
      left: v.left.toString(10),
      right: v.right.toString(10),
    },
    commitment_be: toBE32Hex(F, commitment),
    commitment_dec: toDec(F, commitment),
    nullifier_be: toBE32Hex(F, nullifier),
    nullifier_dec: toDec(F, nullifier),
    merkle_be: toBE32Hex(F, merkle),
    merkle_dec: toDec(F, merkle),
  });
}

console.log(JSON.stringify(out, null, 2));
