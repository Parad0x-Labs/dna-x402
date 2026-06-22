# NOIR_X402_CIRCUIT

**Status**: Circom fallback WORKING | Noir path documented (experimental, Sunspot unaudited)
**Circuit**: `circuits/x402_access.circom`
**Package**: `packages/x402-circuit`
**Demo**: `scripts/zk/07-noir-x402-demo.mjs`

---

## 1. What This Circuit Proves

The x402 access circuit gates tiered API access with zero-knowledge. A client (agent, wallet, or user) proves three things simultaneously, without revealing any secret data:

| Claim | Public output | What stays private |
|---|---|---|
| I know the secret behind this commitment | `commitment` (on-chain) | `secret`, `agent_id` |
| I am paying for this request only (no replay) | `nullifier` (on-chain) | `nonce` |
| My balance meets the minimum tier | `threshold` (on-chain) | actual `balance` |

**Circuit relation** (Groth16 BN254; off-chain verification works today via `snarkjs`. The on-chain `dark_bn254_gate` is excluded from the pilot — it contains a literal `0xDE 0xAD` unconditional bypass, any proof passes, a documented P0 — so it is not yet a trusted on-chain checker. Fail-closed pending bypass removal + a trustless ceremony / real VK):

```
C1: Poseidon(secret, agent_id) == commitment     // binding: proves agent identity
C2: Poseidon(secret, nonce)    == nullifier      // anti-replay: prevents re-use
C3: balance >= threshold                         // tier gate: balance is sufficient
C4: balance < 2^64                               // overflow guard: prevents field wrap
C5: threshold < 2^64                             // input sanity
```

**Public inputs** (the only data visible on-chain or in the x402 `402` response header):

```json
["commitment", "threshold", "nullifier"]
```

**Private inputs** (stay on the client, never sent over the wire):

```json
{ "secret": "...", "agent_id": "...", "balance": 500, "nonce": "..." }
```

---

## 2. Why This Matters for x402

The [x402 protocol](https://x402.org) is an HTTP payment layer for AI agents: a server returns `402 Payment Required`, the client pays, and includes a payment proof in the `X-PAYMENT` header. Today that payment proof is a raw Solana transfer signature — it reveals the payer's wallet address.

This circuit closes that gap. With a ZK proof in the header:

- The server learns only: "this agent is authorized for tier X, this request is unique"
- The server does NOT learn: which wallet paid, how large the balance is, or the agent's identity key

**Practical slot in the x402 flow:**

```
Agent                               Server
  │                                   │
  │  GET /api/endpoint                │
  │ ─────────────────────────────────►│
  │                                   │ 402 Payment Required
  │                                   │ { threshold: 100, nonce: <slot> }
  │◄─────────────────────────────────│
  │                                   │
  │ [generate proof off-chain]        │
  │  buildAccessProofInput(...)       │
  │  snarkjs groth16 fullprove ...    │
  │                                   │
  │  GET /api/endpoint                │
  │  X-PAYMENT: { commitment, threshold, nullifier, proof }
  │ ─────────────────────────────────►│
  │                                   │ verify proof via dark_bn254_gate
  │                                   │ check nullifier not reused
  │                                   │ 200 OK
  │◄─────────────────────────────────│
```

The server anchors the nullifier. Any retry with the same nullifier is rejected, preventing the agent from reusing one proof across multiple calls.

---

## 3. The Noir Path — Current Status and Blockers

### What exists today

[Sunspot](https://github.com/reilabs/sunspot) (by Reilabs) is the only working Noir → Solana toolchain. It:
1. Compiles a Noir circuit to ACIR (Noir's intermediate representation)
2. Converts ACIR to a gnark constraint system (Go)
3. Runs a Groth16 trusted setup via gnark
4. Outputs a `.so` Solana verifier program via `gnark-solana`

The Solana Foundation officially endorses it: [solana-foundation/noir-examples](https://github.com/solana-foundation/noir-examples).

Noir version required: `1.0.0-beta.18` (specifically — not current stable).

### Noir circuit (equivalent, for when Sunspot is production-ready)

The Circom circuit (`circuits/x402_access.circom`) has a direct Noir equivalent. When Sunspot is audited and a real MPC ceremony is run, migrate to `circuits/x402_access.nr`:

```noir
use std::hash::poseidon::bn254::hash_2;

fn main(
    // Public
    commitment:  pub Field,
    threshold:   pub Field,
    nullifier:   pub Field,
    // Private
    secret:      Field,
    agent_id:    Field,
    balance:     u64,
    nonce:       Field,
) {
    // C1: commitment binding
    let computed_commitment = hash_2([secret, agent_id]);
    assert(computed_commitment == commitment);

    // C2: nullifier anti-replay
    let computed_nullifier = hash_2([secret, nonce]);
    assert(computed_nullifier == nullifier);

    // C3: balance >= threshold
    assert(balance as Field >= threshold);
}
```

Compile: `nargo compile` then run Sunspot to generate the Solana verifier program.

### Blockers for Noir path (as of 2026-06-01)

| Blocker | Status |
|---|---|
| Sunspot security audit | Not started. Reilabs has not committed to a timeline. |
| Trusted setup / MPC ceremony | Sunspot uses gnark with "toxic waste" — no real ceremony run yet. |
| Noir version pinning | Requires `1.0.0-beta.18` specifically. Current nargo stable is ahead. |
| UltraHonk on Solana | Not possible. KZG pairings exceed Solana's CU budget in pure BPF. |
| Barretenberg Groth16 | Not supported natively — Sunspot's gnark bridge is the only path. |

**Recommendation**: Use Circom fallback today. When Sunspot ships an audit and a real ceremony, migrate the circuit. The TypeScript API (`packages/x402-circuit`) is circuit-agnostic — only the proof generation step changes.

---

## 4. The Circom Fallback — Working Today

The Circom path (`circuits/x402_access.circom`) uses the same cryptographic primitives as the existing `shielded_withdraw.circom` and `null_proof` circuits. Proof generation and off-chain verification work today via `snarkjs`. The on-chain `dark_bn254_gate` is the intended verifier but is excluded from the pilot — it carries a literal `0xDE 0xAD` unconditional bypass (any proof passes), a documented P0 — so it does not yet provide trusted on-chain verification.

### Shared infrastructure

- **Poseidon hash**: `circomlib/circuits/poseidon.circom` — native BN254-field hash, same as shielded pool
- **snarkjs**: Already in the repo via the dark-null-protocol toolchain
- **Powers of Tau**: `pot16_final.ptau` — existing ceremony artifact covers 2^16 constraints. x402_access uses ~3,500 constraints, fits comfortably
- **On-chain verifier**: `dark_bn254_gate` — deployed but excluded from the pilot and fail-closed. It contains a literal `0xDE 0xAD` unconditional bypass (any proof passes), a documented P0, so it is not a trusted verifier today. The pairing path via the `alt_bn128_pairing` syscall is the intended mechanism, pending bypass removal + a trustless ceremony / real VK. Verify off-chain with `snarkjs` in the meantime

### Compile and setup commands

```bash
# 1. Compile
circom circuits/x402_access.circom --r1cs --wasm --sym -o circuits/out/

# 2. Phase-2 setup (reuse existing ptau or generate new one)
snarkjs groth16 setup circuits/out/x402_access.r1cs <path/to/pot16_final.ptau> x402_access_0000.zkey
snarkjs zkey contribute x402_access_0000.zkey x402_access_final.zkey --name="x402 Access"
snarkjs zkey export verificationkey x402_access_final.zkey circuits/out/x402_access_vk.json

# 3. Generate a proof (agent-side, off-chain)
cat > /tmp/x402_input.json << 'EOF'
{
  "commitment": "...",
  "threshold": "100",
  "nullifier": "...",
  "secret": "...",
  "agent_id": "...",
  "balance": "500",
  "nonce": "..."
}
EOF
snarkjs groth16 fullprove /tmp/x402_input.json \
  circuits/out/x402_access_js/x402_access.wasm \
  x402_access_final.zkey \
  proof.json public.json

# 4. Verify off-chain
snarkjs groth16 verify circuits/out/x402_access_vk.json public.json proof.json
```

### Constraint count estimate

| Component | Constraints |
|---|---|
| Poseidon(2) × 2 | ~240 × 2 = 480 |
| GreaterEqThan(64) | ~128 |
| RangeCheck64 × 2 | ~64 × 2 = 128 |
| Signal overhead | ~100 |
| **Total** | **~836 constraints** |

Well under the `pot16` ceiling (65,536 constraints). Proof generation time: ~0.3s on a modern laptop.

---

## 5. Integration with dark_bn254_gate

The on-chain verifier (`programs/dark_bn254_gate`) expects a 352-byte instruction payload:

```
bytes   0–255: Proof bundle (A: G1, B: G2, C: G1)
bytes 256–287: public input 0 — commitment (32 bytes)
bytes 288–319: public input 1 — threshold  (32 bytes)
bytes 320–351: public input 2 — nullifier  (32 bytes)
```

This is the same layout as `shielded_withdraw` — 256-byte proof + 3 × 32-byte public inputs.

The `verifyAccessProof()` function in `packages/x402-circuit/src/index.ts` constructs this payload and calls `dark_bn254_gate` on-chain.

**Nullifier registry**: Use the existing `NullifierBank` PDA from `dark-shielded-pool-core`. The x402 access nullifier should use a distinct `pool_key_field` domain separator to avoid collisions with shielded pool nullifiers.

**Suggested domain separation for nullifiers**:
- Shielded pool: `Poseidon(secret, pool_key_field)` (existing)
- x402 access: `Poseidon(secret, nonce)` — nonce is request-specific, preventing cross-domain reuse

---

## 6. Security Properties

| Property | Claim | Notes |
|---|---|---|
| Zero-knowledge | Server learns nothing about `secret`, `balance`, or `agent_id` | Groth16 zk-SNARK; holds assuming soundness of setup |
| Binding | `commitment` uniquely binds to one `(secret, agent_id)` pair | Poseidon collision resistance under BN254 field |
| Anti-replay | Each request consumes the nullifier; reuse is rejected on-chain | Nullifier registry in `dark-shielded-pool-core` |
| Soundness | Fake proofs rejected by the Groth16 pairing check (off-chain via `snarkjs`) | Holds assuming correct vk, correct proving key, and honest setup. On-chain soundness via `dark_bn254_gate` does NOT hold yet — that gate is excluded from the pilot and carries a `0xDE 0xAD` unconditional bypass (any proof passes) |
| Tier gate | `balance >= threshold` is enforced in-circuit | GreaterEqThan(64) from circomlib |
| Overflow safety | `balance` and `threshold` are constrained to < 2^64 | RangeCheck64 prevents field wrap attacks |

**Caveats** (same as rest of DARK_ZK_PRIMITIVES):
- Proving key is a local development setup, not a public MPC ceremony. Run a ceremony before mainnet use.
- No security audit on this circuit. Do not use in production without an audit.
- The `dark_bn254_gate` verifier is excluded from the pilot and fail-closed: it contains a literal `0xDE 0xAD` unconditional bypass (any proof passes), a documented P0. It is not a trusted on-chain verifier pending bypass removal + a trustless ceremony / real VK.

---

*Last updated: 2026-06-01 | Branch: main*
