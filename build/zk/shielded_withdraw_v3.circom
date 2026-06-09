pragma circom 2.1.6;

// ShieldedWithdraw v3 - Dark Null shielded pool / DARK RELAY RAIL
//
// ASCII-stripped build copy of circuits/shielded_withdraw_v3.circom. circom 2.1.9's
// parser rejects the non-ASCII comments and global `var`s in the canonical source,
// so this copy moves the constants into the template - logic is byte-identical.
//
// CHANGES FROM v2: in-proof relayer fee binding.
//   v2 public: [nullifier, merkle_root, recipient, pool_id]
//   v3 public: [nullifier, merkle_root, recipient, pool_id, relayer, fee, denomination]
// The proof binds `relayer` and `fee` so the submitter is reimbursed EXACTLY `fee`
// and the recipient receives EXACTLY `denomination - fee`, with fee <= MAX_FEE and
// fee <= denomination (no underflow). Permissionless, incentive-bound relayer market.

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/mux1.circom";
include "circomlib/circuits/comparators.circom";

// -- Merkle tree verifier ------------------------------------------------------
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

// -- main circuit --------------------------------------------------------------
template ShieldedWithdraw(depth) {
    var DOMAIN_COMMIT = 1;
    var DOMAIN_NULLIF = 2;
    var FEE_BITS = 64;
    var MAX_FEE  = 50000000; // 0.05 SOL cap on relayer reimbursement

    // -- Public inputs (all visible on-chain) -----------------------------------
    signal input nullifier;
    signal input merkle_root;
    signal input recipient;
    signal input pool_id;
    signal input relayer;
    signal input fee;
    signal input denomination;

    // -- Private inputs (never leave the client) --------------------------------
    signal input secret;
    signal input leaf_index;
    signal input pool_key_field;
    signal input path_elements[depth];
    signal input path_index[depth];
    signal input payout_recipient; // witness: must equal denomination - fee

    // -- 1. Commit = Poseidon(DOMAIN_COMMIT, secret, leaf_index) ---------------
    component commitment_hasher = Poseidon(3);
    commitment_hasher.inputs[0] <== DOMAIN_COMMIT;
    commitment_hasher.inputs[1] <== secret;
    commitment_hasher.inputs[2] <== leaf_index;
    signal commitment <== commitment_hasher.out;

    // -- 2. Verify commitment is in the Poseidon Merkle tree --------------------
    component merkle_proof = MerkleProof(depth);
    merkle_proof.leaf          <== commitment;
    merkle_proof.root          <== merkle_root;
    merkle_proof.path_elements <== path_elements;
    merkle_proof.path_index    <== path_index;

    // -- 3. Nullifier = Poseidon(DOMAIN_NULLIF, secret, pool_key_field) ---------
    component nullifier_hasher = Poseidon(3);
    nullifier_hasher.inputs[0] <== DOMAIN_NULLIF;
    nullifier_hasher.inputs[1] <== secret;
    nullifier_hasher.inputs[2] <== pool_key_field;
    signal computed_nullifier  <== nullifier_hasher.out;
    nullifier === computed_nullifier;

    // -- 4. Bind recipient, pool_id, relayer ------------------------------------
    signal recipient_check <== recipient;
    signal pool_id_check   <== pool_id;
    signal relayer_check   <== relayer;
    _ <== recipient_check;
    _ <== pool_id_check;
    _ <== relayer_check;

    // -- 5. Fee accounting - relayer-incentive binding --------------------------
    // (a) fee, denomination, payout each in the non-negative u64 range.
    component feeRange = Num2Bits(FEE_BITS);
    feeRange.in <== fee;
    component denomRange = Num2Bits(FEE_BITS);
    denomRange.in <== denomination;
    component payoutRange = Num2Bits(FEE_BITS);
    payoutRange.in <== payout_recipient;

    // (b) fee <= MAX_FEE - relayer cannot over-charge.
    component feeCap = LessEqThan(FEE_BITS);
    feeCap.in[0] <== fee;
    feeCap.in[1] <== MAX_FEE;
    feeCap.out === 1;

    // (c) fee <= denomination - payout cannot underflow.
    component feeLeDenom = LessEqThan(FEE_BITS);
    feeLeDenom.in[0] <== fee;
    feeLeDenom.in[1] <== denomination;
    feeLeDenom.out === 1;

    // (d) payout_recipient === denomination - fee - the split is exact.
    payout_recipient === denomination - fee;
}

// Public signals: nullifier, merkle_root, recipient, pool_id, relayer, fee, denomination
component main {
    public [nullifier, merkle_root, recipient, pool_id, relayer, fee, denomination]
} = ShieldedWithdraw(20);
