pragma circom 2.1.6;

// x402 Access Circuit — Parad0x Labs / DNA x402
//
// Proves: Poseidon(secret, agent_id) == commitment
//     AND balance >= threshold
//
// WITHOUT revealing the balance, secret, or agent wallet.
//
// Public inputs  (visible on-chain / in x402 payment header):
//   - commitment   Poseidon(secret, agent_id) — bound to this agent's credential
//   - threshold    minimum credit balance required for the requested tier
//   - nullifier    Poseidon(secret, nonce) — single-use token, prevents replay
//
// Private inputs (stay client-side, never sent over the wire):
//   - secret       32-byte random secret known only to agent
//   - agent_id     agent's identity field element (e.g. Poseidon(pubkey))
//   - balance      actual credit balance (must be >= threshold)
//   - nonce        unique per-request nonce (e.g. slot number or UUID as field elem)
//
// Circuit relation:
//   C1: Poseidon(secret, agent_id) == commitment         [binding]
//   C2: Poseidon(secret, nonce)    == nullifier          [anti-replay]
//   C3: balance >= threshold                             [tier gate]
//   C4: balance < 2^64 (implicit from RangeCheck)        [overflow guard]
//
// On-chain verification:
//   Groth16 over BN254. Verifier: dark_bn254_gate (Solana mainnet, live).
//   Syscalls used: alt_bn128_pairing (~150k CU, well within 1.4M budget).
//
// Trusted setup note:
//   Use the existing null_proof ceremony artifacts (pot16_final.ptau) or run a
//   separate phase-2 ceremony for this circuit. The ptau covers up to 2^16
//   constraints; this circuit uses ~3,500. Fits comfortably.
//
// Compile:
//   circom circuits/x402_access.circom --r1cs --wasm --sym -o circuits/out/
//
// Phase-2 setup (reuses existing pot file from null_proof ceremony):
//   snarkjs groth16 setup circuits/out/x402_access.r1cs <ptau> x402_access_0000.zkey
//   snarkjs zkey contribute x402_access_0000.zkey x402_access_final.zkey --name="x402 Access Ceremony"
//   snarkjs zkey export verificationkey x402_access_final.zkey circuits/out/x402_access_vk.json
//
// Generate a proof (off-chain, agent-side):
//   snarkjs groth16 fullprove input.json circuits/out/x402_access_js/x402_access.wasm \
//     x402_access_final.zkey proof.json public.json
//
// Proof encoding for x402 header (same layout as dark_bn254_gate):
//   bytes   0–63:   A (G1 point: 32B x + 32B y, big-endian)
//   bytes  64–191:  B (G2 point: 64B x_fp2 + 64B y_fp2, big-endian)
//   bytes 192–255:  C (G1 point: 32B x + 32B y, big-endian)
//   bytes 256–287:  commitment (32B BN254 field element)
//   bytes 288–319:  threshold  (32B BN254 field element)
//   bytes 320–351:  nullifier  (32B BN254 field element)
//   Total: 352 bytes — same instruction layout as shielded_withdraw.

include "node_modules/circomlib/circuits/poseidon.circom";
include "node_modules/circomlib/circuits/comparators.circom";

// ── RangeCheck: assert n < 2^64 ──────────────────────────────────────────────
template RangeCheck64() {
    signal input n;

    // Decompose n into 64 bits. If any higher bit is set, the circuit fails.
    signal bits[64];
    var acc = 0;
    for (var i = 0; i < 64; i++) {
        bits[i] <-- (n >> i) & 1;
        bits[i] * (bits[i] - 1) === 0;  // each bit is 0 or 1
        acc += bits[i] * (1 << i);
    }
    acc === n;
}

// ── Main circuit ──────────────────────────────────────────────────────────────
template X402Access() {
    // ── Public inputs ─────────────────────────────────────────────────────────
    signal input commitment;   // Poseidon(secret, agent_id) — public binding
    signal input threshold;    // minimum balance for tier access
    signal input nullifier;    // Poseidon(secret, nonce) — single-use token

    // ── Private inputs ────────────────────────────────────────────────────────
    signal input secret;       // agent's random secret (never leaves client)
    signal input agent_id;     // agent identity field element
    signal input balance;      // actual credit balance (private)
    signal input nonce;        // per-request nonce (slot or UUID)

    // ── C1: Commitment binding ────────────────────────────────────────────────
    // Proves the agent knows (secret, agent_id) that hash to commitment.
    component commitment_hasher = Poseidon(2);
    commitment_hasher.inputs[0] <== secret;
    commitment_hasher.inputs[1] <== agent_id;
    commitment === commitment_hasher.out;

    // ── C2: Nullifier anti-replay ─────────────────────────────────────────────
    // Proves the nullifier was derived from the same secret + this specific nonce.
    // The nullifier registry on-chain rejects any re-use (same logic as shielded pool).
    component nullifier_hasher = Poseidon(2);
    nullifier_hasher.inputs[0] <== secret;
    nullifier_hasher.inputs[1] <== nonce;
    nullifier === nullifier_hasher.out;

    // ── C3: Balance range check — balance >= threshold ────────────────────────
    // GreaterEqThan(n) component from circomlib asserts a >= b using n-bit comparator.
    // We use 64 bits — covers balances up to ~1.8e19, well above any realistic token supply.
    component gte = GreaterEqThan(64);
    gte.in[0] <== balance;
    gte.in[1] <== threshold;
    gte.out === 1;

    // ── C4: Overflow guard — balance < 2^64 ──────────────────────────────────
    // Prevents a malicious prover from passing balance = p-1 (field overflow attack).
    component range = RangeCheck64();
    range.n <== balance;

    // ── C5: Threshold also bounded ────────────────────────────────────────────
    // Ensures threshold itself is a valid 64-bit number (prevents manipulation).
    component range_t = RangeCheck64();
    range_t.n <== threshold;
}

component main { public [commitment, threshold, nullifier] } = X402Access();
