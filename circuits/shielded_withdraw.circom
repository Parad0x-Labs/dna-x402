pragma circom 2.1.6;

// ShieldedWithdraw circuit - Dark Null shielded pool
//
// Draft status:
//   This circuit is not a final production artifact. Before VK_FINAL can flip:
//   - program and circuit must use the same commitment/nullifier/root hash scheme
//   - recipient must be bound into public inputs to prevent proof redirection
//   - pool identity must be bound into public inputs to prevent nullifier rebinding
//
// Proves knowledge of a secret such that:
//   1. commitment = Poseidon2(secret, leaf_index) is in the Merkle tree with root merkle_root
//   2. nullifier  = Poseidon2(secret, pool_key_field) matches the public nullifier
//
// Public inputs  (visible on-chain):
//   - nullifier        32-byte field element
//   - merkle_root      32-byte field element
//
// Private inputs (stay client-side, never on-chain):
//   - secret           32-byte random value
//   - leaf_index       u64 leaf position
//   - pool_key_field   32-byte pool program ID as field element
//   - merkle_path      TREE_DEPTH × 1 sibling hashes
//   - merkle_path_pos  TREE_DEPTH × 1 left/right indicators (0 or 1)
//
// Compile:
//   circom shielded_withdraw.circom --r1cs --wasm --sym -o out/
//
// Powers of Tau:
//   snarkjs powersoftau new bn128 16 pot16_0000.ptau -v
//   snarkjs powersoftau contribute pot16_0000.ptau pot16_0001.ptau --name="Dark Null" -v
//   snarkjs powersoftau prepare phase2 pot16_0001.ptau pot16_final.ptau -v
//
// Phase 2 setup:
//   snarkjs groth16 setup out/shielded_withdraw.r1cs pot16_final.ptau circuit_0000.zkey
//   snarkjs zkey contribute circuit_0000.zkey circuit_final.zkey --name="Dark Null Ceremony" -v
//   snarkjs zkey verify out/shielded_withdraw.r1cs pot16_final.ptau circuit_final.zkey
//
// Export verifying key:
//   snarkjs zkey export verificationkey circuit_final.zkey vk.json
//   # Then encode the vk.json points into dark-shielded-verifier/src/lib.rs
//
// Generate a proof (for testing):
//   snarkjs groth16 prove circuit_final.zkey out/shielded_withdraw_js/witness.wtns proof.json public.json
//
// Expected output proof.json → encode as 256-byte array:
//   bytes  0..64  = proof["pi_a"][0..1] (G1 point x,y, big-endian 32B each)
//   bytes 64..192 = proof["pi_b"][0..1] (G2 point x_imag, x_real, y_imag, y_real)
//   bytes 192..256 = proof["pi_c"][0..1] (G1 point x,y)

include "node_modules/circomlib/circuits/poseidon.circom";
include "node_modules/circomlib/circuits/mux1.circom";

// ── parameters ─────────────────────────────────────────────────────────────────
// Merkle tree depth — 20 levels supports 2^20 ≈ 1M notes before needing a new pool
var TREE_DEPTH = 20;

// ── Merkle tree verifier ──────────────────────────────────────────────────────
template MerkleProof(depth) {
    signal input leaf;
    signal input root;
    signal input path_elements[depth];
    signal input path_index[depth];   // 0 = leaf on left, 1 = leaf on right

    signal computed_root;

    component poseidons[depth];
    component muxes[depth];
    signal hashes[depth + 1];

    hashes[0] <== leaf;

    for (var i = 0; i < depth; i++) {
        poseidons[i] = Poseidon(2);
        muxes[i]     = MultiMux1(2);

        // If path_index[i] == 0: hash(current, sibling)
        // If path_index[i] == 1: hash(sibling, current)
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
    // Public inputs
    signal input nullifier;
    signal input merkle_root;

    // Private inputs
    signal input secret;
    signal input leaf_index;
    signal input pool_key_field;
    signal input path_elements[depth];
    signal input path_index[depth];

    // ── 1. Compute commitment = Poseidon(secret, leaf_index) ──────────────────
    component commitment_hasher = Poseidon(2);
    commitment_hasher.inputs[0] <== secret;
    commitment_hasher.inputs[1] <== leaf_index;
    signal commitment <== commitment_hasher.out;

    // ── 2. Verify commitment is in Merkle tree ────────────────────────────────
    component merkle_proof = MerkleProof(depth);
    merkle_proof.leaf          <== commitment;
    merkle_proof.root          <== merkle_root;
    merkle_proof.path_elements <== path_elements;
    merkle_proof.path_index    <== path_index;

    // ── 3. Compute nullifier = Poseidon(secret, pool_key_field) ──────────────
    component nullifier_hasher = Poseidon(2);
    nullifier_hasher.inputs[0] <== secret;
    nullifier_hasher.inputs[1] <== pool_key_field;
    signal computed_nullifier  <== nullifier_hasher.out;

    // ── 4. Constrain public nullifier matches circuit-computed one ────────────
    nullifier === computed_nullifier;
}

component main { public [nullifier, merkle_root] } = ShieldedWithdraw(20);
