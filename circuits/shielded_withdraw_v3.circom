pragma circom 2.1.6;

// ShieldedWithdraw v3 — Dark Null shielded pool / DARK RELAY RAIL
//
// CHANGES FROM v2:
//
//   In-proof relayer fee binding (trustless, permissionless relayer market).
//
//   v2 public inputs = [nullifier, merkle_root, recipient, pool_id]
//     The withdraw was paid in full to `recipient`. A `fee_payer` (relayer) signed
//     and funded the nullifier-record rent, but was NOT bound by the proof and got
//     NO reimbursement. The only relayer incentive was altruism — there was no
//     permissionless market, and a relayer could not safely be paid out of the pool
//     because nothing bound the fee.
//
//   v3 public inputs = [nullifier, merkle_root, recipient, pool_id, relayer, fee]
//     The proof now binds:
//       - `relayer`  — the relayer wallet (BN254 Fr field element). The submitter of
//                      the withdraw is reimbursed `fee` lamports from the pool. Because
//                      `relayer` is bound in the proof, a different relayer cannot swap
//                      themselves into the payout slot without a fresh valid proof.
//       - `fee`      — the relayer reimbursement in lamports. Constrained:
//                          fee <= MAX_FEE        (cap — relayer cannot over-charge)
//                          fee <= denomination   (no underflow — payout stays >= 0)
//                          payout_recipient === denomination - fee
//                      so the recipient receives EXACTLY `denomination - fee` and the
//                      relayer receives EXACTLY `fee`. The split is fixed by the proof;
//                      neither the relayer nor a front-runner can redirect or inflate.
//
//     This makes the relayer permissionless AND incentive-bound: anyone can submit a
//     withdraw, gets `fee` for the gas/rent they fronted, and is provably unable to
//     steal the recipient's funds or take more than the capped, proven fee. No central
//     relayer, no admin, no off-chain trust.
//
//   `denomination` is bound as a public input so the on-chain verifier checks the
//   proof against the pool's actual fixed denomination — the relayer cannot claim a
//   fee against a denomination the pool does not have.
//
// Public inputs (visible on-chain — must match instruction accounts/state exactly):
//   - nullifier     BN254 Fr = Poseidon(3, DOMAIN_NULLIF=2, secret, pool_key_field)
//   - merkle_root   BN254 Fr = root of the on-chain Poseidon commitment tree
//   - recipient     BN254 Fr = withdrawal destination wallet (reduced mod r)
//   - pool_id       BN254 Fr = pool program PDA (reduced mod r)
//   - relayer       BN254 Fr = relayer wallet that fronts gas/rent (reduced mod r)
//   - fee           u64-range = relayer reimbursement in lamports (<= MAX_FEE, <= denom)
//   - denomination  u64-range = pool fixed note size in lamports
//
// Private inputs (stay client-side, never on-chain):
//   - secret           32-byte random note secret
//   - leaf_index       u64 leaf position in the commitment tree
//   - pool_key_field   pool program PDA as Fr field element
//   - path_elements    TREE_DEPTH sibling hashes
//   - path_index       TREE_DEPTH left/right indicators (0=left, 1=right)
//   - payout_recipient witness = denomination - fee (constrained, not free)
//
// Compile:
//   circom circuits/shielded_withdraw_v3.circom --r1cs --wasm --sym -l node_modules -o out/
//
// Ceremony (TRUSTLESS target):
//   Phase-1: ingest a PUBLIC Perpetual Powers of Tau (Hermez powersOfTau28).
//   Phase-2: MULTIPLE independent `snarkjs zkey contribute` from different humans,
//            then a PUBLIC RANDOM BEACON (drand) finalisation. See ceremony/README.md.

include "node_modules/circomlib/circuits/poseidon.circom";
include "node_modules/circomlib/circuits/mux1.circom";
include "node_modules/circomlib/circuits/comparators.circom";

// ── parameters ─────────────────────────────────────────────────────────────────
// Merkle tree depth — 20 levels = up to 2^20 ≈ 1M notes per pool.
var TREE_DEPTH = 20;

// Domain tags — prevent cross-function Poseidon collisions.
var DOMAIN_COMMIT = 1;
var DOMAIN_NULLIF = 2;

// Fee accounting bit-width. Lamports fit in u64, so 64 bits bounds fee, denomination
// and payout to the non-negative u64 range. MAX_FEE caps the relayer reimbursement.
// 50_000_000 lamports = 0.05 SOL — generous headroom over real devnet tx+rent cost
// (~0.0001 SOL) while staying well below the 0.1 SOL smallest denomination bucket.
var FEE_BITS = 64;
var MAX_FEE  = 50000000;

// ── Merkle tree verifier ──────────────────────────────────────────────────────
template MerkleProof(depth) {
    signal input leaf;
    signal input root;
    signal input path_elements[depth];
    signal input path_index[depth];   // 0 = leaf on left, 1 = leaf on right

    component poseidons[depth];
    component muxes[depth];
    signal hashes[depth + 1];

    hashes[0] <== leaf;

    for (var i = 0; i < depth; i++) {
        poseidons[i] = Poseidon(2);
        muxes[i]     = MultiMux1(2);

        muxes[i].c[0][0] <== hashes[i];
        muxes[i].c[0][1] <== path_elements[i];
        muxes[i].c[1][0] <== path_elements[i];
        muxes[i].c[1][1] <== hashes[i];
        muxes[i].s       <== path_index[i];

        poseidons[i].inputs[0] <== muxes[i].out[0];
        poseidons[i].inputs[1] <== muxes[i].out[1];

        hashes[i + 1] <== poseidons[i].out;
    }

    root === hashes[depth];
}

// ── main circuit ──────────────────────────────────────────────────────────────
template ShieldedWithdraw(depth) {
    // ── Public inputs (all visible on-chain) ───────────────────────────────────
    signal input nullifier;
    signal input merkle_root;
    signal input recipient;
    signal input pool_id;
    signal input relayer;        // relayer wallet (reduced mod r) — bound, reimbursed
    signal input fee;            // relayer reimbursement in lamports (<= MAX_FEE, <= denom)
    signal input denomination;   // pool fixed note size in lamports

    // ── Private inputs (never leave the client) ────────────────────────────────
    signal input secret;
    signal input leaf_index;
    signal input pool_key_field;
    signal input path_elements[depth];
    signal input path_index[depth];
    signal input payout_recipient; // witness: must equal denomination - fee

    // ── 1. Commit = Poseidon(DOMAIN_COMMIT, secret, leaf_index) ───────────────
    component commitment_hasher = Poseidon(3);
    commitment_hasher.inputs[0] <== DOMAIN_COMMIT;
    commitment_hasher.inputs[1] <== secret;
    commitment_hasher.inputs[2] <== leaf_index;
    signal commitment <== commitment_hasher.out;

    // ── 2. Verify commitment is in the Poseidon Merkle tree ────────────────────
    component merkle_proof = MerkleProof(depth);
    merkle_proof.leaf          <== commitment;
    merkle_proof.root          <== merkle_root;
    merkle_proof.path_elements <== path_elements;
    merkle_proof.path_index    <== path_index;

    // ── 3. Nullifier = Poseidon(DOMAIN_NULLIF, secret, pool_key_field) ─────────
    component nullifier_hasher = Poseidon(3);
    nullifier_hasher.inputs[0] <== DOMAIN_NULLIF;
    nullifier_hasher.inputs[1] <== secret;
    nullifier_hasher.inputs[2] <== pool_key_field;
    signal computed_nullifier  <== nullifier_hasher.out;
    nullifier === computed_nullifier;

    // ── 4. Bind recipient, pool_id, relayer (front-run / redirect protection) ──
    // These are public, so a substituted value invalidates the proof. The explicit
    // assignments keep the optimiser from dropping the wires.
    signal recipient_check <== recipient;
    signal pool_id_check   <== pool_id;
    signal relayer_check   <== relayer;
    _ <== recipient_check;
    _ <== pool_id_check;
    _ <== relayer_check;

    // ── 5. Fee accounting — the relayer-incentive binding ──────────────────────
    //   (a) fee, denomination, payout each lie in the non-negative u64 range.
    component feeRange = Num2Bits(FEE_BITS);
    feeRange.in <== fee;
    component denomRange = Num2Bits(FEE_BITS);
    denomRange.in <== denomination;
    component payoutRange = Num2Bits(FEE_BITS);
    payoutRange.in <== payout_recipient;

    //   (b) fee <= MAX_FEE — relayer cannot over-charge.
    component feeCap = LessEqThan(FEE_BITS);
    feeCap.in[0] <== fee;
    feeCap.in[1] <== MAX_FEE;
    feeCap.out === 1;

    //   (c) fee <= denomination — payout cannot underflow.
    component feeLeDenom = LessEqThan(FEE_BITS);
    feeLeDenom.in[0] <== fee;
    feeLeDenom.in[1] <== denomination;
    feeLeDenom.out === 1;

    //   (d) payout_recipient === denomination - fee — the split is exact.
    payout_recipient === denomination - fee;
}

// Public signals (declaration order = snarkjs public-signal order):
//   nullifier, merkle_root, recipient, pool_id, relayer, fee, denomination
component main {
    public [nullifier, merkle_root, recipient, pool_id, relayer, fee, denomination]
} = ShieldedWithdraw(20);
