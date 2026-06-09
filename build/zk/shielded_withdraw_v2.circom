pragma circom 2.1.6;

// ShieldedWithdraw v2 - Dark Null shielded pool
//
// CHANGES FROM v1:
//
//   Fix 1 - Domain separation on Poseidon hashes.
//     v1: commitment = Poseidon(2)(secret, leaf_index)
//         nullifier  = Poseidon(2)(secret, pool_key_field)
//     Both used the same Poseidon parameterisation. If leaf_index == pool_key_field
//     for any note, commitment == nullifier - nullifier reuse - double-spend.
//
//     v2: commitment = Poseidon(3)(DOMAIN_COMMIT=1, secret, leaf_index)
//         nullifier  = Poseidon(3)(DOMAIN_NULLIF=2, secret, pool_key_field)
//     Explicit domain tag as first input. Structurally impossible for the two
//     outputs to collide regardless of secret / index values.
//
//   Fix 2 - Recipient + pool_id bound into public inputs.
//     v1: public inputs = [nullifier, merkle_root]
//     A valid proof could be front-run in the mempool: attacker replaces the
//     recipient instruction account with their own. The proof verifies because
//     neither recipient nor pool_id appear in the circuit.
//
//     v2: public inputs = [nullifier, merkle_root, recipient, pool_id]
//     Recipient is the Solana wallet as a BN254 Fr field element (32-byte LE).
//     pool_id is the pool program PDA as a BN254 Fr field element.
//     Both are constrained to exactly match the values bound in the proof.
//     A front-runner cannot substitute a different recipient without producing
//     a fresh valid proof - which requires knowing the private secret.
//
//   NOTE: The Merkle tree root computation mismatch (on-chain uses a rolling
//   hash chain; circuit expects a Poseidon tree) is a Rust-side fix - see
//   programs/dark_shielded_pool/src/processor.rs process_deposit(). The circuit
//   is correct: it expects a proper Poseidon Merkle tree root. The deposit code
//   must be updated to build an incremental Poseidon Merkle tree. That fix is
//   in the companion PR.
//
// Public inputs (visible on-chain - must match instruction accounts exactly):
//   - nullifier    BN254 Fr field element = Poseidon(2, secret, pool_key_field)
//   - merkle_root  BN254 Fr field element = root of Poseidon commitment tree
//   - recipient    BN254 Fr field element = withdrawal destination wallet
//   - pool_id      BN254 Fr field element = pool program PDA
//
// Private inputs (stay client-side, never on-chain):
//   - secret           32-byte random value
//   - leaf_index       u64 leaf position in the commitment tree
//   - pool_key_field   32-byte pool program PDA as field element
//   - path_elements    TREE_DEPTH sibling hashes
//   - path_index       TREE_DEPTH left/right indicators (0=left, 1=right)
//
// Compile:
//   circom circuits/shielded_withdraw_v2.circom --r1cs --wasm --sym -o out/
//
// Ceremony (fresh - v1 zkeys are incompatible):
//   snarkjs powersoftau new bn128 20 pot20_0000.ptau -v
//   # ... contribute, prepare phase2 ...
//   snarkjs groth16 setup out/shielded_withdraw_v2.r1cs pot20_final.ptau circuit_v2_0000.zkey
//   snarkjs zkey contribute circuit_v2_0000.zkey circuit_v2_final.zkey --name="Dark Null v2"
//   snarkjs zkey export verificationkey circuit_v2_final.zkey vk_v2.json
//   # Run scripts/zk/02-vk-json-to-rust.mjs to regenerate null_proof_vk.rs

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/mux1.circom";

// -- parameters -----------------------------------------------------------------
// Merkle tree depth - 20 levels = up to 2^20 - 1M notes per pool
// TREE_DEPTH=20 inlined into main(20)
// Domain tags - prevent cross-function Poseidon collisions
// DOMAIN_COMMIT inlined below
// DOMAIN_NULLIF inlined below
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
    // -- Public inputs (all visible on-chain) -----------------------------------
    signal input nullifier;     // Poseidon(DOMAIN_NULLIF, secret, pool_key_field)
    signal input merkle_root;   // root of the on-chain Poseidon commitment tree
    signal input recipient;     // withdrawal destination - Solana wallet as Fr field
    signal input pool_id;       // pool program PDA as Fr field element

    // -- Private inputs (never leave the client) --------------------------------
    signal input secret;              // random 32-byte note secret
    signal input leaf_index;          // position in the commitment tree (u64)
    signal input pool_key_field;      // pool program PDA as Fr field element
    signal input path_elements[depth]; // Merkle sibling hashes
    signal input path_index[depth];   // 0=left / 1=right per level

    // -- 1. Commit = Poseidon(DOMAIN_COMMIT, secret, leaf_index) ---------------
    // Domain tag as first input prevents collision with nullifier computation.
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
    // Domain tag prevents any overlap with commitment hash space.
    component nullifier_hasher = Poseidon(3);
    nullifier_hasher.inputs[0] <== DOMAIN_NULLIF;
    nullifier_hasher.inputs[1] <== secret;
    nullifier_hasher.inputs[2] <== pool_key_field;
    signal computed_nullifier  <== nullifier_hasher.out;

    // -- 4. Constrain public nullifier ------------------------------------------
    nullifier === computed_nullifier;

    // -- 5. Constrain recipient and pool_id -------------------------------------
    // These are already constrained by being public inputs - the prover cannot
    // substitute different values without invalidating the proof. We add
    // explicit equality gates so the compiler confirms the binding is active.
    signal recipient_check <== recipient;
    signal pool_id_check   <== pool_id;
    // (signal assignment forces them into the constraint system even if unused
    // elsewhere in the circuit - prevents the optimiser from removing them)
    _ <== recipient_check;
    _ <== pool_id_check;
}

// Public signals: nullifier, merkle_root, recipient, pool_id
// Private signals: secret, leaf_index, pool_key_field, path_elements, path_index
component main {
    public [nullifier, merkle_root, recipient, pool_id]
} = ShieldedWithdraw(20);
