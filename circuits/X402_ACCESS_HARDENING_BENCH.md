# x402 Access Gate — Held-Out Adversarial Benchmark (the yardstick)

**Authored before the fix.** Defines the pass/fail criteria the hardened circuit must
meet, so the fix is graded against fixed targets — not self-reported success.

## The defect (v1 — `x402_access.circom`)

The shipped circuit proves `balance >= threshold` where `balance` is a **free private
witness bound to nothing on-chain**:

```
C3: balance >= threshold      // balance invented by the prover
```

`commitment = Poseidon(secret, agent_id)` is also self-asserted (both inputs free). So a
caller with no credit at all sets `balance := threshold` and produces a verifying proof.
The "meets an access threshold" claim is a tautology.

## The hardened invariant (v2 — `x402_access_v2.circom`)

Access entitlement = **"I hold a settlement-written receipt in the canonical receipt tree
whose `amount >= threshold`, presented for this resource scope + epoch, under my
identity."** The amount is opened from a Merkle-proven leaf, never invented:

```
leaf  = Poseidon5(agent_commitment, amount, timestamp, counterparty, receipt_nonce)
        // identical leaf format to receipt_commitment_tree.settle_and_record / track_record
MerkleProof(leaf, root, path)                         // membership in the anchored tree
amount       >= threshold                             // the threshold check, now bound
agent_commitment == Poseidon(secret, agent_id)        // identity (anti-lending)
nullifier    == Poseidon(DOMAIN_ACCESS, secret, scope_hash, epoch)   // scope+epoch rate-limit
```

On-chain, `root` is bound to the canonical `receipt_commitment_tree` PDA (mirrors
`dark_reputation_gate`), so a prover cannot substitute a self-made tree of fake leaves.

## Grade matrix

Two layers. **Circuit layer** (snarkjs, no chain) is the primary held-out grade — it
proves the tautology is gone at the math level. **Chain layer** (deployed gate) covers the
root-binding + replay, which live in the program, not the circuit.

| # | Case | Construction | MUST | Layer |
|---|------|--------------|------|-------|
| **V1** | tautology demo | v1 circuit, `balance:=threshold`, no backing | proof **VERIFIES** (defect reproduced on our own bench) | circuit |
| **A1** | forge amount | v2, invented `amount`/leaf, no real Merkle path | **witness-gen FAILS** (`root === hashes[depth]` unsatisfiable) → no proof exists | circuit |
| **A2** | below threshold | v2, real leaf, `amount < threshold` | **witness-gen FAILS** (`GreaterEqThan` constraint) | circuit |
| **A3** | self-made root | v2, real-looking leaf in attacker's own tree, valid path to attacker root | proof verifies vs attacker root BUT gate **REJECTS** `Custom(11)` (root not canonical) | chain |
| **A4** | replay | v2 legit proof, submit twice (same scope+epoch ⇒ same nullifier) | 2nd submit **REJECTS** `Custom(3)` (nullifier PDA exists) | chain |
| **A5** | proof-lending / wrong identity | take a valid proof, try to bind a different `agent_commitment` | proof **fails verification** (agent_commitment is a public input fixed in the proof) | circuit |
| **A6** | cross-scope replay | legit proof for scope X presented at scope Y | gate verify **fails** (scope_hash public input mismatch) | chain |
| **L1** | legit | v2, real receipt leaf in canonical tree, `amount >= threshold`, fresh scope/epoch | proof **VERIFIES** + gate **ACCEPTS** + nullifier recorded | both |

## Pass condition for the fix

**V1 reproduces the defect** AND **A1, A2, A5 fail at the circuit layer** AND **A3, A4, A6
are rejected at the chain layer** AND **L1 passes end-to-end**. Anything less = the fix is
not done. Grades are produced by running the cases, not asserted.

## Why this is held-out

A1/A2 must fail at *witness generation* — i.e. it is cryptographically impossible to
produce a proof, not merely that our verifier happens to reject one. That is the bright
line between this and the v1 tautology: in v1 a forged witness is *satisfiable*; in v2 it
is not. If any forge case produces a valid proof, the tautology survived and the fix fails.
