# Goblin Engineering Roadmap — Next Primitives

**Updated:** 2026-05-31  
**Status:** All items verified against live Solana state + deep research.

---

## Priority 1 — Build NOW (this week)

### 1. WebAuthn PRF → Native Ed25519 (Dark Passport Tier 1b)

**What:** Use the WebAuthn PRF extension to derive a native Solana Ed25519 keypair from biometric auth. The key never leaves the hardware authenticator.

**Why it's a first:** LazorKit, Privy, Para, Turnkey — all still proxy through Ed25519 via MPC or custody. None use PRF to derive Ed25519 directly. **Zero Solana implementations exist.**

**The primitive:**
```
navigator.credentials.get({ extensions: { prf: { eval: { first: salt } } } })
→ prf_output (32 bytes from hardware)
→ HKDF(prf_output, salt, "dark-passport-prf-v1")
→ Ed25519 seed → Keypair.fromSeed()
→ Native Solana transaction signing
```

**Browser support:** Chrome 132+, Safari 18+, Android Chrome (Pixel 6+/Seeker)  
**Demo:** `scripts/passport/04-prf-ed25519-demo.mjs` ✅ proven deterministic  
**Status:** Math proven. Browser test page + vault program update next.

---

### 2. BLS12-381 Credential Aggregation Demo (devnet → mainnet first)

**What:** Aggregate N agent BLS signatures into ONE on-chain verification. Each agent "signs" its credential; the verifier checks all N credentials with a single pairing.

**Why it's a first:** SIMD-0388 BLS12-381 syscalls are **live on devnet** (epoch 1059, feature `b1sgUiJ3qu7hYm3tNDyyqZNQd6gLGJmJppnLNa93PCQ`). **No open-source BLS12-381 Solana program exists.** Mainnet activation pending (queue started May 29).

**The syscalls:**
```rust
sol_curve_group_op(curve_id=5 /* G1 */, ADD, p1_bytes, p2_bytes) // G1 add
sol_curve_group_op(curve_id=6 /* G2 */, ADD, p1_bytes, p2_bytes) // G2 add  
sol_curve_pairing_map(curve_id=4 /* BLS12-381 */, g1_points, g2_points) // batch pairing
```

**Use case:** 1000 agents hold a Dark Passport credential. A verifier checks all 1000 valid with ONE on-chain tx instead of 1000.

**Timeline:** Build on devnet NOW. Flip to mainnet when feature gate activates (~Q3 2026).

---

### 3. SIMD-0064 Transaction Receipt Revival

**What:** Revive the stagnant SIMD-0064 (transaction inclusion proofs). Original proposers (Tinydancer/Jump Crypto) went inactive Oct 2024.

**Why:** Our `receipt_anchor` program is the application layer. SIMD-0064 is the missing block-level inclusion proof underneath it.

**Immediate action:** Submit PR to `solana-foundation/solana-improvement-documents` as new champion. Add Groth16 Merkle inclusion proof variant (our `dark_bn254_gate` is already the verifier).

**PR draft:** `docs/SIMD_0064_REVIVAL_PR.md` (write this)  
**Grant angle:** Direct match for Solana Foundation agentic payments grant.

---

## Priority 2 — Build this month

### 4. JS ZK Browser SDK (`@parad0x_labs/zk`)

**What:** Browser-native ZK proof generation SDK. Uses our existing snarkjs pipeline + the null_proof circuit. Developers call `generateProof(inputs)` and get a proof they can submit on-chain.

**Why:** Solana Foundation **explicitly named** "JS ZK library for confidential balances" as a missing unlock. No browser-native ZK proof SDK exists for Solana.

**Base:** `scripts/zk/01-groth16-proof-demo.mjs` is already the proof. Package it.

---

### 5. ZK ElGamal Vacancy Play

**What:** Solana's confidential transfer program was **disabled June 2025** (soundness bug). PYUSD, AUSD, USDG have frozen confidential transfers. Re-enablement pending audit (code-423n4/2025-08-solana-foundation).

**When it comes back:** The space needs a production Groth16 shielded pool. Our `dark_shielded_pool` + `dark_bn254_gate` + 2-party ceremony = the readiest team.

**Action:** Monitor the audit timeline. When re-enabled, ship `dark_shielded_pool` as THE private transfer layer.

---

### 6. Credential Chaining

**What:** ZK proof that a credential was issued by institution X which was itself attested by root Y — a full trust chain on-chain.

**Why:** Solana Attestation Service (SAS, launched May 2026) supports single-issuer credentials. Nobody has built chaining. Nobody.

---

## Priority 3 — Q3 2026 (post-audit, post-BLS mainnet)

### 7. Multi-Device Passkey Recovery (On-Chain, No Cloud)

**What:** Register N passkeys on-chain. Lose one device → recover with another registered device. No seed phrase. No iCloud/Google cloud dependency.

**Why:** LazorKit relies on OS-level sync. Pure on-chain recovery protocol: unbuilt anywhere on Solana.

---

### 8. WebAuthn PRF + ZK Witness

**What:** PRF(salt) → 32 bytes → ZK witness for the Semaphore circuit. Prove you authenticated without revealing which passkey or which device.

**Why:** PRF-derived ZK witnesses = hardware-bound anonymous credentials. Completely unbuilt.

---

## Grant targets (submit now)

| Target | Program | Ask |
|---|---|---|
| Agentic payments + SIMD-0064 revival | Solana Foundation | Part of $65k ask |
| BLS12-381 first implementation | Solana Foundation | New ask |
| JS ZK browser SDK | Solana Foundation (named gap) | New ask |
| ZK ElGamal replacement layer | Solana Foundation (after re-audit) | Post-audit ask |

---

## What's confirmed live today

| Primitive | Status |
|---|---|
| Groth16 ZK verification on mainnet | ✅ `GCptvBYF...` |
| secp256r1 (Face ID) binding on mainnet | ✅ `3hbbtje...` |
| secp256k1 (MetaMask) binding on mainnet | ✅ `9iwkua...` |
| x402 payment rail | ✅ mainnet |
| Receipt anchoring | ✅ mainnet |
| BLS12-381 syscalls | ✅ devnet (pending mainnet) |
| PRF → Ed25519 derivation | ✅ math proven, browser page next |

---

*github.com/Parad0x-Labs/dna-x402*
