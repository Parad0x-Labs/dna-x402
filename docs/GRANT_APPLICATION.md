# Solana Foundation Grant Application

**Project:** DNA x402 — AI Agent Payment Rail with Biometric Identity and Compressed Private Receipts
**Applicant:** Parad0x Labs / sls_0x
**Repository:** https://github.com/Parad0x-Labs/dna-x402 (MIT)
**Date:** 2026-05-31

---

## 1. Executive Summary

DNA x402 is an open-source, on-chain payment rail that lets AI agents pay for services using the HTTP 402 protocol — no backend custody, no intermediary signing, no API keys for money movement. We have deployed 8 programs to Solana mainnet-beta, proven biometric passkey identity verification on-chain with real transactions, and shipped a compressed/private receipt settlement layer (Liquefy) that reduces 1 million agent payment receipts to a single 32-byte on-chain commitment. We are requesting a grant to fund an external security audit of all 8 programs and to complete the two ZK programs currently blocked on stubs, so that each program can flip `IS_MAINNET_READY=true` on audit sign-off.

---

## 2. What's Built and Live on Mainnet-Beta

All 8 programs deployed 2026-05-29 to Solana mainnet-beta, all verified executable.

| Program | Address | Status |
|---|---|---|
| `dark_semaphore` | `Ev7HEFhhKTXk6kS2Y6ssbUcK9C7E6yZ589jJNjUrQV5p` | Pilot |
| `dark_secp256r1_vault` | `3hbbtjeSrTVYXq6eRwjeofDe2DCPh3n8cfN6kZcQfewi` | Pilot — P-256 proven on mainnet |
| `dark_secp256k1_auth` | `AqwBbV13AoczhoELwP8oxT3nDqB6MsLWXauNzHkssZ9B` | Pilot |
| `null_token_hook` | `14ivonrNRmaMbJMQkGdHVVTcqZYhNvchULWxveazhW2g` | Pilot |
| `null_lottery` | `3t5c2Trk4SFK7hvKVjsmmC2xQtasFnK9pJQRdwPHqxbG` | Pilot |
| `null_mint_gate` | `5jduvBZggszFeE7uxxNrvZAp8pJxzqtgzBGqg12fKhC1` | Pilot |
| `receipt_anchor` | `6HSRGivdYR5D7yTDy1TFMCM8h3LzXxRtKU1RA3RnCMRN` | Pilot |
| `dark_proof_gate_lite` | `PmSCTuehX1MYxf8GNsGsUZySYTtqWAtuTt3N2xZLpw2` | Pilot |

**NULL token (Token-2022):** `8EeDdvCRmFAzVD4takkBrNNwkeUTUQh4MscRK5Fzpump`

**Biometric passport — proven on mainnet:**
- Register tx: [28sEcKd…](https://explorer.solana.com/tx/28sEcKdS8VwSvUtG796BJDoATQoysHnHN3edNMnk3V3vNPThuNtjyKUD7mkLPH1QUb1HJ3X6JPNMPkPkckJnVj1P?cluster=mainnet-beta)
- Sign-in tx: [295YoPd…](https://explorer.solana.com/tx/295YoPdoXbs2NMfftcRu8pa1vEjdhQbRcKNQVaoV88s5XeX5DVFhnY8ZhksEkH8Wpm82dswQo7xnNgf2mZXHj6mJ?cluster=mainnet-beta)
- Wrong-key rejection: `0x4009 PasskeyPubkeyMismatch` — on-chain error, not client-side
- Tested on Solana Seeker (Android fingerprint via Chrome)

**Test coverage:** 1990+ unit tests, 12-scenario adversarial mayhem suite (12/12 pass), devnet CI, BETA_READY gate (0 blockers).

**Liquefy receipt compression (MIT):**
- 62× columnar compression on structured payment receipt JSON
- Bilateral netting: 1M receipts → ~4,950 net settlements before compression
- AES-256-GCM encryption (only transacting parties see amounts)
- Streaming Merkle root: O(log N) memory, any batch → 32 bytes on-chain
- [github.com/Parad0x-Labs/liquefy](https://github.com/Parad0x-Labs/liquefy)

---

## 3. What's Genuinely New

We do not claim to be first with passkeys on Solana, first with ZK on Solana, or first with x402 (Coinbase and others exist). What we believe is new:

**First Solana x402 micropayment rail for AI agents.** No prior Solana implementation closes the loop: agent makes a request, receives a 402, pays on Solana, resource is delivered — without backend custody or intermediate signers.

**First biometric passkey identity verification on Solana with challenge-rotation sign-in.** A P-256 public key bound to a PDA via SIMD-0075 precompile, with per-request challenge rotation, tested on real hardware (Solana Seeker). This is agent identity attestation — distinct from passkey wallets.

**First compressed, netted, private settlement layer for AI agent micropayments.** Liquefy + `receipt_anchor`: bulk flows are netted, compressed 62×, encrypted, committed as a single 32-byte Merkle root. One transaction. No amounts visible on-chain.

**The combination in one OSS stack.** x402 payment routing + biometric agent identity + compressed private receipts + ZK enforcement roadmap — not assembled elsewhere as a single deployable, permissively-licensed Solana program set.

---

## 4. Grant Ask

**Total requested: $65,000 USD**

| Item | Amount | Detail |
|---|---|---|
| External security audit — all 8 programs | $50,000 | Targeting OtterSec, Neodyme, or Halborn. ~3-4 week engagement. |
| `dark_bn254_gate` — real Groth16 VK | $7,500 | Remove devnet bypass. Generate VK from production trusted-setup ceremony. |
| `dark_shielded_pool` — Poseidon + ceremony | $5,000 | Replace `IS_STUB=true`. Poseidon hash alignment, recipient binding, multi-party ceremony. |
| Squads multisig migration | $2,500 | All 8 program upgrade authorities transferred to Squads v4 multisig before audit. |

Every dollar goes to audit, ZK production cryptography, and governance hardening. No salaries, marketing, or token liquidity.

---

## 5. Team

**Parad0x Labs / sls_0x** — solo founder / lead engineer. Full-stack Solana: Anchor programs, Rust, TypeScript SDK, secp256r1/SIMD-0075, Groth16 ZK circuits, AES-GCM, CI/CD, adversarial test harnesses. All 8 mainnet programs, the compression library, and the biometric passport flow were built and deployed by one person.

Evidence of execution: 8 programs on mainnet 2026-05-29, biometric passport proven on-chain same day, 1990+ tests, 12/12 adversarial scenarios passing.

---

## 6. Why Solana

**Performance.** AI agent micropayments require negligible fees and sub-second finality. 400ms finality and sub-$0.001 fees are not achievable on any other L1 without rollup complexity.

**SIMD-0075.** The secp256r1 precompile makes biometric passkey verification viable on-chain without a trusted relay. This precompile does not exist on Ethereum L1. The entire Dark Passport architecture depends on it.

**Token-2022.** Transfer hooks, confidential transfers, and transfer fee extensions give NULL programmable behavior SPL cannot provide.

**Solana Seeker.** We tested biometric login on the Seeker specifically because it is the clearest signal of what Solana's mobile-native developer ecosystem enables.

---

## 7. OSS Commitment and Ecosystem Impact

All 8 programs are MIT-licensed. Liquefy is MIT-licensed. No gating on the OSS fork.

**OSS fork:** `protocolFeeBps = 0`, permissionless, no backend required.
**Commercial rail:** Parad0x operates at `protocolFeeBps = 5` (0.05%). Operators set their own fees (0–2000 bps).

Post-audit, this becomes a reference implementation for any developer building agent-to-agent payments, machine-identity systems, or private settlement on Solana. The receipt compression and netting logic is reusable for any high-throughput settlement use case.

---

## 8. Risk Disclosure

**`IS_MAINNET_READY=false` on all 8 programs.** Enforcement logic is deliberately fail-open in the current pilot. External audit sign-off required before any program flips to `true`.

**`dark_bn254_gate` excluded from pilot.** Contains a literal `0xDE 0xAD` unconditional bypass — any proof passes. Documented P0, not deployed in pilot. Grant deliverable: remove bypass, real VK.

**`dark_shielded_pool` excluded from pilot.** `IS_STUB=true` and `MAINNET_READY=false` are public constants. Not deployed in pilot.

**No external audit completed.** Internal review, cargo-audit, clippy, and 1990+ tests have run. Not a substitute for external audit. Grant is to fund that audit.

**Single-key upgrade authority.** Identified governance risk. Squads migration is a grant deliverable.

**Phantom precompile incompatibility.** Phantom's in-app browser does not support the secp256r1 precompile. Working client today: Chrome or Mobile Wallet Adapter. Known limitation, tracked upstream.

---

## 9. Timeline (3 months)

**Month 1 — Governance and audit preparation**
- Squads v4 multisig migration: all 8 programs, single-key authority retired
- Audit firm engaged. Code freeze. Full documentation package delivered.

**Month 2 — ZK sprint and audit execution**
- Track A: `dark_bn254_gate` — real Groth16 VK from Powers of Tau ceremony
- Track B: `dark_shielded_pool` — Poseidon alignment, recipient binding, ceremony
- Track C: External audit running. Findings addressed in real time.

**Month 3 — Remediation, sign-off, IS_MAINNET_READY=true**
- Audit findings remediated. Re-audit critical findings if required.
- Per-program `IS_MAINNET_READY=true` flip, one at a time, in order of sign-off.
- Public audit report (full disclosure, 30-day embargo max if firm requires).
- SDK stable release.

**Deliverables at grant close:**
- [ ] All 8 programs under Squads multisig upgrade authority
- [ ] Published external audit report
- [ ] `IS_MAINNET_READY=true` for each program cleared by audit
- [ ] `dark_bn254_gate`: real VK, bypass removed
- [ ] `dark_shielded_pool`: stub replaced, ceremony complete
- [ ] SDK stable release tagged
- [ ] Full audit report in public repo

---

*Contact: sls_0x — github.com/Parad0x-Labs. All evidence, test logs, and deployment artifacts in the public repo: github.com/Parad0x-Labs/dna-x402*
