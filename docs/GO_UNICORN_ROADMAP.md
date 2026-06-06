# GO-LIVE / GO-UNICORN — Dark Null ZK Privacy Stack

*Synthesized 2026-06-06 from a 13-agent audit+research swarm (1.4M tokens, 420 tool calls,
37 audit findings, 28 innovation recs, 130 adversarial ratings). Discipline: confirmed-real
only; rejected-hype dropped; claims bounded by `mainnet_ready` flags.*

---

## 1. MUST-FIX before devnet deploy of `dark_x402_access_gate`

**The real verifier path is correct — safe to deploy to devnet.**

Re-confirmed against source: `dark-groth16-core::groth16_verify` implements
`e(A,B)·e(-α,β)·e(-vk_x,γ)·e(-C,δ)=1` correctly; the `x402_access_vk` constants byte-match
`vk.json` (22/22 arrays); the circuit is fully constrained (no under-constraints); the BPF
path is backstopped by the `alt_bn128` syscall (rejects off-curve / non-subgroup / over-modulus
points). A genuine proof returns `Ok(true)`; forged/garbage/zero proofs are rejected. **No
fail-open in the real verifier path.**

Three real gaps that do NOT block devnet but DO block trust/mainnet:
| Ref | Issue | Fix |
|---|---|---|
| F-1-0 | No `mainnet_ready` guard; loads `mainnet_ready:false` (devnet single-party) VK | Before mainnet: `if !vk.mainnet_ready { return Err(Custom(2)); }` behind a devnet-allow flag |
| F-1-1 | Nullifier parsed + logged, never persisted → proofs replayable | Before trust: `dark_nullifier_record` PDA (`seeds=[b"nullifier", nullifier]`); mark after verify |
| F-1-7 | `threshold` is prover-chosen, not bound to requested tier | Before trust: caller passes required threshold; gate asserts `>=` |

> **Ship the devnet deploy. Land F-1-0 / F-1-1 / F-1-7 + the ceremony before any mainnet claim.**

---

## 2. The real unicorn wedge

### WEDGE #1 (lead): Bound x402 Payment-Authorization Capability
A signed, scope-limited, **single-use** payment capability an agent presents with an x402
request, binding: (a) which facilitator may settle, (b) a per-`(payment_id, resource_id)`
nullifier, (c) TTL by slot, (d) spend cap + scope hash, (e) a stealth recipient.
- **Effort ~2-4 wk.** Substrate is REAL: `dark-macaroons` uses real `Hmac<Sha256>` (RFC2104),
  caveat already carries `max_amount_lamports`, `allowed_scope_hashes`, `expires_at_slot`,
  `allowed_relayer_class`, `no_withdraw`. `dark_x402_access_gate` is the live on-chain Groth16.
  Build = add `(payment_id, resource_id)` + stealth field → wire `allowed_relayer_class` into
  the facilitator verify → deploy `dark_nullifier_record` (this IS the F-1-1 fix) → e2e.
- **Moat:** owns a layer nobody holds. Umbra/Arcium hide the value transfer; AP2 defines a
  Mandate schema with zero chain-native enforcement; zBase is a mixer. Matches the only
  peer-grade x402 attack paper's mitigations M2 (caller-binding) + M3 (single-use).

### WEDGE #2 (complement): Real BN254 stealth-address receipts
Per-receipt recipient unlinkability via ECDH; view-key for compliance.
- **Effort Low-Med.** `dark-stealth-address` does GENUINE BN254 G1 ECDH (`g1_mul_scalar`/
  `g1_add`/`g1_generator`; SHA256 only as the KDF on the shared point — correct ECIES/Monero,
  NOT the stub). Same curve as the Groth16 verifier → one pipeline. Work = `StealthReceipt`
  account + view-key indexer. Finalize the one-time spend-key derivation (`spend_secret +
  shared_scalar mod order`).

### Complement #3: ZK proof-of-innocence + budget compliance
- Innocence half REAL + near-shippable (`dark-proof-of-innocence` — add on-chain root anchoring).
  Budget half (`dark-x402-compliance-proof`) is a SHA256 STUB — rebuild on the live `x402_access`
  range gadget, re-ceremony, audit. Do NOT ship the stub.

> **Cheapest add:** commit-reveal anti-front-run (`dark-x402-commit-reveal` — logic exists, add
> on-chain anchor, model on the already-mainnet `receipt_anchor`).

---

## 3. DROP list (never market; these are due-diligence landmines)

**Tier A — fail-open "verifiers" (off-chain/SDK, 0 on-chain consumers):** `dark-zk-snark-stub`,
`dark-zkp-groth16-v2`, `dark-zkp-bulletproof`, `dark-zk-snark-v2`, `dark-zk-rollup-stub`,
`dark-proof-aggregator`, `dark-recursive-proof`, `dark-reputation-score` — all return true
without verifying. Fail-close or rename.
**Tier B — attestation theater:** `dark_ritual_gate` (binds the instructions sysvar but never
reads it; `EchoProof` returns `Accepted` unconditionally). Add `NOT_A_VERIFIER` banner.
**Tier C — relabel:** `dark-shielded-verifier` off-chain branch returns `Ok(true)` (on-chain
path is real) — make non-solana branch return `Err`. `dark-pool-sdk::verify_stub_proof` →
`dry_run_gate_hash`.
**Tier D — do not lead with:** standalone shielded pool / IMT as a "first" (Umbra is live
mainnet); Token-2022 Confidential Transfers (ZK ElGamal proof program disabled mainnet epoch 805).

---

## 4. The honest unicorn thesis

Coinbase's x402 whitepaper contains **zero** mentions of privacy or identity — it sells
on-chain transparency as a feature — so the default agent-payment trail is permanently
correlatable, and the niche of *"prove you're authorized and funded without revealing how much,
which wallet, or which APIs"* is occupied by **nobody**: mixers hide the link not the credential;
AP2 defines a Mandate schema with no chain-native enforcement; the agent-identity category
(Solana Agent Registry, ERC-8004, Kite Passport, SAID) is public-reputation-by-design; Solana
Confidential Transfers hide only the amount. The defensible win is the **convergence no one
bundles** — x402 wiring + on-chain ZK access-gating + a `.null` identity bound *inside* the
Groth16 commitment (`Poseidon(secret, agent_id)`) + recipient-unlinkable receipts on the *same
BN254 curve* — credible precisely because the repo enforces this honesty in code: a real,
tested `alt_bn128` Groth16 verifier + private access circuit on **devnet**, `.null` registrar on
**mainnet**, ceremony + private receipts as the funded roadmap — **not** "live private payments
on mainnet."

---

## 5. Ceremony plan (resolves blocker #4 — single-party setup)

Raw `snarkjs` (p0tion is sunset; artifacts are snarkjs-compatible either way):
- **Step 0:** fix the `power 20` header error — that's tree capacity, not constraints. Compile +
  `snarkjs r1cs info` → x402_access = 1,233 constraints → power 11. Shielded pool (~5-6k) → 14.
- **Step 1:** reuse a phase-2-ready ptau (Hermez 54 contribs, or PSE Perpetual PoT 80) — never
  run your own phase-1. `snarkjs powersoftau verify ...` MUST print "OK!".
- **Step 2:** multi-party phase-2 — 7-15 visibly-independent contributors sequentially
  (`snarkjs zkey contribute`), finalize with a PRE-COMMITTED public beacon (future block/drand).
  Soundness needs 1 honest contributor; credibility scales with count + independence.
- **Step 3:** publish a `ceremony/` dir — circuit source + r1cs SHA-256, final zkey + transcript,
  one independently-published attestation Gist per contributor (handle/index/64-hex hash),
  beacon pre-commitment. Third party runs `snarkjs zkey verify` → "ZKey Ok!".
- **Step 4:** flip `mainnet_ready` only post external audit.

---

## 6. Sequenced roadmap

**THIS WEEK — devnet + cheap credibility (no blockers):**
1. Deploy `dark_x402_access_gate` to devnet (verifier confirmed correct).
2. **Add the positive E2E CI test** (highest leverage, ~1 day): parse a real `proof.json`+
   `public.json` → wire format → assert `groth16_verify == Ok(true)`. Would have caught every
   VK mismatch. (G2 conversion: `x_im←c1, x_re←c0, y_im←c1, y_re←c0`, 32-byte BE.)
3. Proof compression 256→128 bytes (mainnet syscalls live since v1.16) — X-PAYMENT header win.
4. Ceremony Step 0 (fix the power-20 header).
5. Drop/rename the Tier-A stubs.

**THIS MONTH — build the wedge + de-risk:**
6. Wedge #1: caveat `(payment_id, resource_id)` + stealth field; deploy `dark_nullifier_record`
   (= F-1-1 fix); wire `allowed_relayer_class`; e2e vs the published x402 attacks.
7. Wedge #2: `StealthReceipt` + view-key indexer; finalize one-time spend-key derivation.
8. **Swap to audited crates**: `dark-groth16-core` internals → **Lightprotocol/groth16-solana**
   (audited, backs sp1-solana); on-chain Poseidon → **light-poseidon** (Veridise-audited,
   circomlib-compatible). Turns the biggest liability into an audited component.
9. Run the multi-party ceremony (Steps 1-3).

**BEFORE MAINNET:**
10. External audit of verifier + circuits; only then flip `mainnet_ready`.
11. Land F-1-0 guard, F-1-1 nullifier persistence, F-1-7 threshold-binding (most fall out of Wedge #1).
12. Shielded pool (if pursued): real incremental Poseidon Merkle tree (semaphore-rs), real
    recipient binding, 4-input verifier, one byte order, governance-gated root; compile
    `shielded_withdraw_v2`; assert circomlib-Poseidon == `sol_poseidon` Bn254X5.

**Rejected-hype (kept out):** Penumbra poseidon377/decaf377, Renegade, Noir UltraHonk (wrong
curve / non-Groth16 / blow CU); standalone shielded pool as a "first"; Token-2022 confidential
balances as the wedge; OpenCal calendar / AgentShield insurance / Dark Flux DEX / INFER token
(all off-lane separate-company scope-creep). `sonobe` folding before the BN254 base is finished.
