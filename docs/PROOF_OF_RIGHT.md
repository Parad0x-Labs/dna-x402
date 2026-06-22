# Proof-of-Right (POR)

**Version:** 0.1 — Initial specification  
**Date:** 2026-05-31  
**Authors:** Parad0x Labs  
**Repo:** github.com/Parad0x-Labs/dna-x402

---

## What is Proof-of-Right?

A **Proof-of-Right** is a zero-knowledge proof that asserts:

> *"I am authorized to perform action X"*

without revealing the credential, balance, identity, history, or path that granted that authorization.

The system that verifies the proof does not need your full story. It only needs a valid proof.

---

## The problem with existing authorization

For most of digital history, systems have asked the wrong question:

**"Who are you?"**

This forces disclosure:
- Show your identity
- Show your balance
- Show your transaction history  
- Show the trail that proves you can act

Every verification leaks information. Every proof of authorization is a confession about your state.

---

## The Proof-of-Right question

**"Can you prove you are allowed to act — without exposing the path that gave you that right?"**

This is a fundamentally different model:

| Traditional | Proof-of-Right |
|---|---|
| Show your balance to prove solvency | Prove you can pay without revealing your balance |
| Show your identity to prove membership | Prove you're in the group without revealing who you are |
| Show your transaction history to prove work | Prove a task was completed without revealing which task |
| Show credentials to prove authorization | Prove you have the right without revealing the credential |

---

## Formal definition

A **Proof-of-Right** is a tuple `(π, pub)` where:

- `π` is a Groth16 (or equivalent) zero-knowledge proof
- `pub` is a set of public inputs (nullifier, Merkle root, commitment, etc.)

Such that:

1. **Soundness:** No party without the correct secret can generate a valid `π`
2. **Zero-knowledge:** `π` reveals nothing about the secret beyond what `pub` already commits to
3. **On-chain verifiability:** Any Solana validator can verify `π` against the public VK in `O(1)` time using the `alt_bn128_pairing` syscall
4. **Nullifier binding:** Each right can be exercised at most once per nullifier, preventing double-use

---

## DNA x402 implementation

### Programs (Solana mainnet-beta)

| Program | Role in POR | Status |
|---|---|---|
| `dark_bn254_gate` (`GCptvBYF...`) | Intended on-chain Groth16 verifier for the POR primitive | ⛔ Excluded from pilot — `0xDE 0xAD` unconditional bypass (any proof passes), documented P0, fail-closed pending bypass removal + a trustless ceremony / real VK. Off-chain Groth16 verification via `snarkjs` works today. |
| `dark_semaphore` (`Ev7HEFhh...`) | Nullifier registry — prevents double-exercise of rights | Pilot |
| `dark_proof_gate_lite` (`PmSCTueh...`) | Lightweight proof-of-claim anchor | Pilot |
| `receipt_anchor` (`6HSRGivd...`) | Permanent on-chain proof of receipts | Pilot |
| `dark_secp256r1_vault` (`3hbbtje...`) | Biometric identity — proves operator identity | Pilot |

### Circuit

**NullProofV2** — MiMCSponge commitment + nullifier + 7-level Merkle tree

```
Private inputs:  secret, leaf_index, pool_key_field, Merkle path
Public outputs:  commitment, nullifier, Merkle root
Public inputs:   amount, receiver_token_0/1, mint_0/1
```

Proves: "I know a secret that opens a commitment in the tree, and the nullifier matches."

### Ceremony

**Hermez ptau14** (phase 1, 1000s of contributors) + **2-party phase 2** (Parad0x Labs + public beacon). Evidence: `evidence/zk/ceremony-v2.json`.

### Proof verification

Off-chain Groth16 verification (the binding soundness check for POR) runs today via
`snarkjs groth16 verify`.

The transaction below landed against `dark_bn254_gate`, but that gate is excluded from the
pilot: it carries a `0xDE 0xAD` unconditional bypass (any proof passes), a documented P0, so
this is NOT a trusted on-chain proof check. It is fail-closed pending bypass removal + a
trustless ceremony / real VK.

```
TX: 3zpKr4pccPC7334L1Uw9ejbyr2e5P3Zr45Yqitetvg8Wr61bTtqNKTFyB6Kpj2rGwfQKNdTCocrZeCHR3uAma6yR
Cluster: Solana mainnet-beta
Program: GCptvBYF8S6eVYoh15B7WAESc54FUHCpN1Ui6aHeQYZd  (excluded stub — 0xDE 0xAD bypass)
CU used: ~114,000 (well within 400k limit)
```

---

## Use cases

### Private settlement (Dark Pool)
An agent proves it made a deposit and is authorized to withdraw — without linking the deposit to the withdrawal. The nullifier prevents double-withdrawal. The chain sees only the proof.

### Agent authorization
An AI agent proves it holds a valid Dark Passport (biometric-bound identity) and has completed N tasks (nullifier count) to access a higher-value resource — without revealing its identity or task history.

### Private x402 payments  
1 million agent micropayments are netted, compressed 62×, encrypted, and committed to chain as a single Merkle root. Any party can prove any payment is in the batch via a Merkle inclusion proof. No amounts are visible on-chain.

### Membership gating
Prove you are in a group (Semaphore nullifier tree) without revealing which member you are. Gate access to resources, APIs, or governance votes.

---

## What Proof-of-Right is NOT

- It is **not** a new cryptographic primitive. The underlying math (Groth16, Merkle trees, nullifiers) has existed since the 1980s-2010s.
- It is **not** a consensus mechanism. POR is an authorization primitive, not a chain design.
- It is **not** finished. The current deployment is a disclosed pre-audit pilot. `IS_MAINNET_READY` flags will be activated per-program after external audit.

---

## Roadmap

| Milestone | Status |
|---|---|
| Groth16 verifier on Solana mainnet | ⛔ Excluded from pilot (`GCptvBYF...` — `0xDE 0xAD` bypass; fail-closed pending real VK + trustless ceremony). Off-chain verification works today. |
| Biometric identity binding (Loop) | ✅ Live (`3hbbtje...`) |
| Nullifier registry | ✅ Live (`Ev7HEFhh...`) |
| Compressed private receipt batches | ✅ Live (`6HSRGivd...`) |
| Dark Pool (shielded transfers) | 🔲 Post-audit |
| Multi-party ceremony (N > 2) | 🔲 Post-audit |
| Full WebAuthn authenticatorData binding | 🔲 Sprint 2 |
| Agent-to-agent POR authorization | 🔲 Sprint 2 |

---

## The one-line version

> The chain does not need your full story. It only needs a valid proof.

---

*© 2026 Parad0x Labs — MIT License*  
*github.com/Parad0x-Labs/dna-x402*  
*github.com/Parad0x-Labs/Dark-Null-Protocol*
