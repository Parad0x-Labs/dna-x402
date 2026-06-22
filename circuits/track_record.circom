pragma circom 2.1.6;

// Track-Record Circuit — Parad0x Labs / DNA x402  (dark_reputation_gate)
//
// Proves: the agent owns K receipts in the anchored Poseidon receipt tree, all
// within a time window, distinct, totalling >= min_volume, count >= min_count —
// WITHOUT revealing any receipt's amount, timestamp, counterparty, or id, and
// (optionally) without revealing the agent's identity.
//
// The privacy inversion of SAID's public ReceiptAnchor + reputation.
//
// Public inputs:
//   root                  anchored receipt Merkle root (verifier checks == on-chain)
//   min_count             required receipt count (the requested tier bar; <= K)
//   min_volume            required total volume
//   window_start          earliest acceptable timestamp (e.g. now - 90d)
//   reputation_nullifier  Poseidon(DOMAIN_REP, secret, epoch) — single-use per epoch
//   agent_commitment      Poseidon(secret, agent_id) — same identity as the access gate
//   epoch                 the time bucket the nullifier is bound to; PUBLIC so the gate can
//                         require epoch == floor(Clock.unix_timestamp / EPOCH_LEN) and thereby
//                         cap each identity to one reputation spend per window (anti-Sybil)
//
// Private inputs (per receipt i in [0,K)):
//   secret, agent_id,
//   amount[i], timestamp[i], counterparty[i], receipt_nonce[i],
//   leaf_index[i], path_elements[i][depth], path_index[i][depth]
//
// Leaf (written by the settlement layer, never self-asserted):
//   leaf = Poseidon(agent_commitment, amount, timestamp, counterparty, receipt_nonce)
//
// Compile:  circom circuits/track_record.circom --r1cs --wasm --sym -o circuits/out/

include "node_modules/circomlib/circuits/poseidon.circom";
include "node_modules/circomlib/circuits/mux1.circom";
include "node_modules/circomlib/circuits/comparators.circom";

// ── Poseidon Merkle inclusion (same gadget as shielded_withdraw_v2) ───────────
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
        // path bits must be boolean (also used below to bind leaf_index)
        path_index[i] * (path_index[i] - 1) === 0;

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

// ── Main ──────────────────────────────────────────────────────────────────────
template TrackRecord(K, depth) {
    signal input root;
    signal input min_count;
    signal input min_volume;
    signal input window_start;
    signal input reputation_nullifier;
    signal input agent_commitment;

    signal input secret;
    signal input agent_id;
    signal input epoch;
    signal input amount[K];
    signal input timestamp[K];
    signal input counterparty[K];
    signal input receipt_nonce[K];
    signal input leaf_index[K];
    signal input path_elements[K][depth];
    signal input path_index[K][depth];

    var DOMAIN_REP = 7;

    // 1. agent_commitment == Poseidon(secret, agent_id)  (same as access gate)
    component ac = Poseidon(2);
    ac.inputs[0] <== secret;
    ac.inputs[1] <== agent_id;
    agent_commitment === ac.out;

    // 2. reputation_nullifier == Poseidon(DOMAIN_REP, secret, epoch)
    component rn = Poseidon(3);
    rn.inputs[0] <== DOMAIN_REP;
    rn.inputs[1] <== secret;
    rn.inputs[2] <== epoch;
    reputation_nullifier === rn.out;

    component leafH[K];
    component merkle[K];
    component tsCheck[K];
    signal sumAcc[K + 1];
    signal idxAcc[K];
    sumAcc[0] <== 0;

    for (var i = 0; i < K; i++) {
        // leaf = Poseidon(agent_commitment, amount, ts, counterparty, nonce)
        leafH[i] = Poseidon(5);
        leafH[i].inputs[0] <== agent_commitment;
        leafH[i].inputs[1] <== amount[i];
        leafH[i].inputs[2] <== timestamp[i];
        leafH[i].inputs[3] <== counterparty[i];
        leafH[i].inputs[4] <== receipt_nonce[i];

        // membership in the anchored tree
        merkle[i] = MerkleProof(depth);
        merkle[i].leaf          <== leafH[i].out;
        merkle[i].root          <== root;
        merkle[i].path_elements <== path_elements[i];
        merkle[i].path_index    <== path_index[i];

        // bind claimed leaf_index to the actual Merkle path bits
        var acc = 0;
        for (var j = 0; j < depth; j++) { acc += path_index[i][j] * (1 << j); }
        idxAcc[i] <== acc;
        leaf_index[i] === idxAcc[i];

        // window: timestamp >= window_start
        tsCheck[i] = GreaterEqThan(64);
        tsCheck[i].in[0] <== timestamp[i];
        tsCheck[i].in[1] <== window_start;
        tsCheck[i].out === 1;

        sumAcc[i + 1] <== sumAcc[i] + amount[i];
    }

    // 3. Distinctness — leaf_index strictly increasing (no double-counting)
    component idxLt[K - 1];
    for (var i = 0; i < K - 1; i++) {
        idxLt[i] = LessThan(32);
        idxLt[i].in[0] <== leaf_index[i];
        idxLt[i].in[1] <== leaf_index[i + 1];
        idxLt[i].out === 1;
    }

    // 4. count: min_count <= K
    component cnt = LessEqThan(32);
    cnt.in[0] <== min_count;
    cnt.in[1] <== K;
    cnt.out === 1;

    // 5. volume: sum >= min_volume
    component vol = GreaterEqThan(64);
    vol.in[0] <== sumAcc[K];
    vol.in[1] <== min_volume;
    vol.out === 1;
}

// v1 (devnet POC) sized to the available pot14 ptau: K=4 receipts, depth-10 tree.
// Production scales to K=16 / depth-20 with a larger ptau (pot20).
component main {
    public [root, min_count, min_volume, window_start, reputation_nullifier, agent_commitment, epoch]
} = TrackRecord(4, 10);
