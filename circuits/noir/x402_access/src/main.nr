// x402 Access Circuit — Parad0x Labs
// Proves an agent is authorized for a payment tier
// WITHOUT revealing: wallet address, actual balance, or identity
//
// Public inputs:
//   commitment     - Pedersen commitment to (secret, agent_id)
//   threshold      - minimum balance required for this tier
//   nullifier      - prevents double-use of same proof
//
// Private inputs:
//   secret         - agent's random secret
//   agent_id       - agent's identifier (field element)
//   balance        - actual balance (must be >= threshold)
//   nonce          - for nullifier binding (per-request slot)
//
// Deployment status:
//   Circom path: LIVE on Solana devnet (program: 7LZzJnLSCCu2enc7mXz9FFCbomotME78xFG4eqkpo5U6)
//   Noir path:   Source here — pending nargo + Sunspot toolchain installation
//   Both use Groth16 over BN254 — same on-chain verifier math.

fn main(
    // Public
    commitment: pub Field,
    threshold:  pub u64,
    nullifier:  pub Field,
    // Private
    secret:   Field,
    agent_id: Field,
    balance:  u64,
    nonce:    Field,
) {
    // 1. Verify commitment = Pedersen(secret, agent_id)
    let computed_commitment = std::hash::pedersen_hash([secret, agent_id]);
    assert(computed_commitment == commitment, "commitment mismatch");

    // 2. Verify balance >= threshold (range proof)
    assert(balance >= threshold, "insufficient balance for tier");

    // 3. Verify nullifier = hash(secret, nonce) — prevents replay
    let computed_nullifier = std::hash::pedersen_hash([secret, nonce]);
    assert(computed_nullifier == nullifier, "nullifier mismatch");
}
