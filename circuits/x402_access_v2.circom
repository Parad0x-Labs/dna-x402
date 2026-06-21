pragma circom 2.1.6;

// x402 Access Circuit v2 — Parad0x Labs / DNA x402  (dark_x402_access_gate)
//
// HARDENS v1 (x402_access.circom), whose `balance >= threshold` rested on a FREE
// witness `balance` bound to nothing — any caller set balance := threshold and a
// verifying proof existed (a tautology). v2 binds the threshold check to a REAL,
// settlement-written credit: the prover opens an `amount` from a leaf it proves is a
// member of the canonical receipt tree. No backing receipt ⇒ no satisfying witness.
//
// Proves (zero-knowledge):
//   1. agent_commitment == Poseidon(secret, agent_id)                       [identity / anti-lending]
//   2. leaf = Poseidon5(agent_commitment, amount, ts, counterparty, nonce)  [same leaf as receipt tree]
//   3. MerkleProof(leaf, root, path)                                        [membership in anchored tree]
//   4. amount >= threshold                                                  [the gate, now bound to a real credit]
//   5. nullifier == Poseidon(DOMAIN_ACCESS, secret, scope_hash, epoch)      [per (agent,resource,epoch) rate-limit]
//
// Public inputs  (order MUST match dark_x402_access_gate's public_inputs[]):
//   root             anchored receipt Merkle root — gate checks == canonical receipt_commitment_tree PDA
//   threshold        minimum settled amount the resource requires
//   scope_hash       BN254-Fr reduction of the x402 resource scope (binds the proof to THIS resource)
//   epoch            rate-limit window
//   nullifier        Poseidon(DOMAIN_ACCESS, secret, scope_hash, epoch) — recorded single-use on-chain
//   agent_commitment Poseidon(secret, agent_id) — same identity element the reputation gate uses
//
// Private inputs:
//   secret, agent_id                                  agent identity (never leave the client)
//   amount, timestamp, counterparty, receipt_nonce    the opened receipt leaf's fields
//   path_elements[depth], path_index[depth]           Merkle authentication path to `root`
//
// The leaf format is IDENTICAL to receipt_commitment_tree.settle_and_record and
// track_record.circom, so any settled receipt of amount >= threshold is a valid access
// credit. A leaf only enters the tree as a side-effect of a real on-chain payment, so the
// amount cannot be fabricated — this is what closes the v1 tautology.
//
// Compile: circom circuits/x402_access_v2.circom --r1cs --wasm --sym -o circuits/out/

include "node_modules/circomlib/circuits/poseidon.circom";
include "node_modules/circomlib/circuits/mux1.circom";
include "node_modules/circomlib/circuits/comparators.circom";

// ── RangeCheck: assert n < 2^64 (so GreaterEqThan(64) is sound on its inputs) ────
template RangeCheck64() {
    signal input n;
    signal bits[64];
    var acc = 0;
    for (var i = 0; i < 64; i++) {
        bits[i] <-- (n >> i) & 1;
        bits[i] * (bits[i] - 1) === 0;
        acc += bits[i] * (1 << i);
    }
    acc === n;
}

// ── Poseidon Merkle inclusion (same gadget as track_record / shielded_withdraw_v2) ──
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
        path_index[i] * (path_index[i] - 1) === 0;     // boolean

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

// ── Main ────────────────────────────────────────────────────────────────────────
template X402AccessV2(depth) {
    // Public
    signal input root;
    signal input threshold;
    signal input scope_hash;
    signal input epoch;
    signal input nullifier;
    signal input agent_commitment;

    // Private
    signal input secret;
    signal input agent_id;
    signal input amount;
    signal input timestamp;
    signal input counterparty;
    signal input receipt_nonce;
    signal input path_elements[depth];
    signal input path_index[depth];

    // Domain tag for the access nullifier — distinct from track_record's DOMAIN_REP=7.
    var DOMAIN_ACCESS = 11;

    // 1. Identity: agent_commitment == Poseidon(secret, agent_id). Binds the credit and
    //    the nullifier to a secret only this agent holds (a stolen proof can't be re-bound).
    component ac = Poseidon(2);
    ac.inputs[0] <== secret;
    ac.inputs[1] <== agent_id;
    agent_commitment === ac.out;

    // 2. Reconstruct the receipt leaf exactly as the settlement layer wrote it.
    component leafH = Poseidon(5);
    leafH.inputs[0] <== agent_commitment;
    leafH.inputs[1] <== amount;
    leafH.inputs[2] <== timestamp;
    leafH.inputs[3] <== counterparty;
    leafH.inputs[4] <== receipt_nonce;

    // 3. Membership: the leaf is in the anchored tree whose root the gate pins on-chain.
    //    No real receipt ⇒ root === hashes[depth] is unsatisfiable ⇒ NO witness exists.
    component merkle = MerkleProof(depth);
    merkle.leaf          <== leafH.out;
    merkle.root          <== root;
    merkle.path_elements <== path_elements;
    merkle.path_index    <== path_index;

    // 4. The threshold gate — now over a Merkle-bound `amount`, not a free witness.
    component amtRange = RangeCheck64();
    amtRange.n <== amount;
    component thRange = RangeCheck64();
    thRange.n <== threshold;

    component gte = GreaterEqThan(64);
    gte.in[0] <== amount;
    gte.in[1] <== threshold;
    gte.out === 1;

    // 5. Scope+epoch-bound nullifier: Poseidon(DOMAIN_ACCESS, secret, scope_hash, epoch).
    //    Same (agent,resource,epoch) ⇒ same nullifier ⇒ on-chain single-use rate limit.
    component nf = Poseidon(4);
    nf.inputs[0] <== DOMAIN_ACCESS;
    nf.inputs[1] <== secret;
    nf.inputs[2] <== scope_hash;
    nf.inputs[3] <== epoch;
    nullifier === nf.out;
}

// v2 (devnet) sized to the receipt tree: depth-10 (matches receipt_commitment_tree DEPTH=10).
component main {
    public [root, threshold, scope_hash, epoch, nullifier, agent_commitment]
} = X402AccessV2(10);
