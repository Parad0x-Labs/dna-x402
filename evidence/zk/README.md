# ZK Proof Demo — Real Groth16, Honest Scope

Reproduce: `npm run zk:demo`

## What this is

A **real Groth16 proof** for the `null_proof` circuit (BN254): a MiMCSponge
commitment + nullifier + 7-level Merkle-tree membership relation. The script:

1. Generates a proof from a witness (`snarkjs groth16 fullprove`)
2. Verifies the valid proof → **PASS** (`snarkJS: OK!`)
3. Tampers one public signal (`amount 1000000 → 1000001`) and re-verifies →
   **REJECTED** (`Invalid proof`) — this is the soundness check

Both halves run in ~3 seconds on commodity hardware. Anyone can replay it.

## Artifacts (this directory)

| File | What |
|------|------|
| `proof.json` | the real Groth16 proof (pi_a / pi_b / pi_c on BN254) |
| `public.json` | 8 public signals (commitment, nullifier, root, amount, receiver, mint) |
| `vk.json` | the verifying key |
| `groth16-proof-demo.json` | machine-readable result + SHA-256 of circuit/r1cs/zkey/wasm/vk |

The verifying key is also encoded for **on-chain** verification via the
`groth16-solana` crate (`dark-null-protocol/src/verifying_key.rs`,
`VK_JSON_SHA256` recorded).

## Honest scope — read before quoting

- This is a **real** proof. The ZK math and pipeline are real and reproducible.
  It is **not** a stub or a mock.
- The proving key is from a **local development setup, not a public multi-party
  ceremony** (see `dark-null-protocol/CEREMONY.md`). It is not mainnet trust by
  itself.
- This demo is **off-chain** proof generation + verification. The on-chain
  verifier (`dark_bn254_gate`) is **fail-closed pending audit** — it rejects all
  proofs until a `mainnet_ready` ceremony VK is wired.

### What it proves
The ZK stack is real, working, and reproducible — not vaporware.

### What it does NOT prove
Audited. Mainnet-ready. Safe fund settlement. Those require a multi-party
ceremony + external audit — the grant scope.
