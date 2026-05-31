# Solana Foundation Developer Grant Application

**Project name:** DNA x402 / Parad0x Labs
**Applicant:** sls_0x — github.com/Parad0x-Labs
**Repository:** https://github.com/Parad0x-Labs/dna-x402 (MIT)
**Grant ask:** $65,000 USD
**Date:** 2026-05-31

---

## PIECE 1 — Elevator Pitch (initial application form, <100 words)

DNA x402 is an open-source Solana payment rail that lets AI agents pay for HTTP-gated services on-chain — no backend custody, no API keys for money movement. Eight programs are live on mainnet-beta, including a biometric passkey identity layer proven on real hardware (Solana Seeker) using the secp256r1 precompile, and a compressed receipt settlement system that reduces 1 million agent payment receipts to a single 32-byte on-chain commitment. The grant funds an external security audit of all 8 programs and removes two stub/bypass conditions blocking production readiness.

---

## PIECE 2 — What Will You Build (3–5 bullets)

- **External security audit of 8 deployed Solana programs** — engage OtterSec, Neodyme, or Halborn for a full audit; address all findings; flip `IS_MAINNET_READY=true` per program on audit sign-off; publish the full report.
- **`dark_bn254_gate` — real Groth16 verifier** — remove the current unconditional `0xDE 0xAD` bypass; generate a production verification key from a Powers of Tau ceremony; deliver a real on-chain Groth16 proof gate.
- **`dark_shielded_pool` — Poseidon hash alignment and ceremony** — replace `IS_STUB=true` stub; align Poseidon parameters to match the circuit, add recipient binding, complete a multi-party trusted setup ceremony.
- **Squads v4 multisig upgrade authority** — transfer all 8 program upgrade authorities from single-key to Squads v4 multisig before the audit code freeze; retire the single-key governance risk.
- **SDK stable release** — tag a stable SDK release after audit sign-off; publish integration docs so any builder can deploy the OSS fork (`protocolFeeBps = 0`, permissioned fork removed) without the Parad0x backend.

---

## PIECE 3 — Full Grant Application (<1500 words)

### 1. Project Description

DNA x402 is an open-source, on-chain payment rail for AI agents. It implements the HTTP 402 "Payment Required" protocol directly on Solana: an agent hits a gated resource, receives a 402 response, signs and submits a Solana transaction, and the resource is delivered — no backend custody, no intermediate signing service, no API keys mediating money movement. The project also includes Dark Passport (biometric passkey identity for agents) and Liquefy (compressed, private bulk receipt settlement). All code is MIT-licensed.

This is not a whitepaper project. Eight programs are deployed and verifiable on Solana mainnet-beta today. The grant is to fund the external security audit that gates production launch and to finish two ZK components currently in documented stub/bypass state.

---

### 2. What Is Built and Live on Mainnet-Beta

All 8 programs deployed 2026-05-29. All are verifiable executables.

| Program | Mainnet Address | Status |
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

**Biometric passport — proven on mainnet with real hardware:**
- Register tx: `28sEcKdS8VwSvUtG796BJDoATQoysHnHN3edNMnk3V3vNPThuNtjyKUD7mkLPH1QUb1HJ3X6JPNMPkPkckJnVj1P`
- Sign-in tx: `295YoPdoXbs2NMfftcRu8pa1vEjdhQbRcKNQVaoV88s5XeX5DVFhnY8ZhksEkH8Wpm82dswQo7xnNgf2mZXHj6mJ`
- Wrong-key rejection confirmed on-chain: `0x4009 PasskeyPubkeyMismatch` — enforcement is in the Solana program, not the client
- Tested on Solana Seeker (Android fingerprint via Chrome)

**Test coverage:** 1990+ unit tests, 12-scenario adversarial mayhem suite (12/12 pass), devnet CI, BETA_READY gate at 0 blockers.

**Liquefy receipt compression (MIT, separate repo):**
- 62x columnar compression on structured payment receipt JSON
- Bilateral netting: 1M receipts collapse to ~4,950 net settlements before compression
- AES-256-GCM encryption — only transacting parties see amounts
- Streaming Merkle root: O(log N) memory, any batch size → 32 bytes on-chain

---

### 3. What Is Genuinely New

We do not claim to be first with passkeys, ZK, or x402 on Solana or elsewhere. The combination is what is new:

**x402 micropayment rail on Solana for AI agents.** No prior Solana implementation closes the full loop: agent makes a request, receives a 402, pays on Solana, resource is delivered — without backend custody or intermediate signers.

**Challenge-rotation biometric identity attestation on Solana.** A P-256 public key bound to a PDA via SIMD-0075 (secp256r1 precompile), with per-request challenge rotation and on-chain enforcement. This is agent identity attestation, not a passkey wallet — a distinct use case. The SIMD-0075 precompile does not exist on Ethereum L1; the architecture depends on it.

**Compressed, private, netted bulk receipt settlement.** Liquefy + `receipt_anchor`: bulk agent payment flows are bilaterally netted, compressed 62x, AES-encrypted, and committed as a single 32-byte Merkle root in one transaction. No amounts are visible on-chain.

**One MIT-licensed deployable stack.** x402 routing + biometric agent identity + compressed private receipts + ZK enforcement — assembled together, permissively licensed, no Parad0x backend required for the OSS fork.

---

### 4. Why Solana

**400ms finality and sub-$0.001 fees.** AI agent micropayments are economically viable only at these parameters. This is not available on Ethereum L1 without rollup complexity.

**SIMD-0075 secp256r1 precompile.** Biometric passkey (P-256 / WebAuthn) on-chain verification without a trusted relay. The entire Dark Passport architecture depends on this precompile. Not available on Ethereum L1.

**Token-2022.** Transfer hooks, confidential transfers, and transfer fee extensions give NULL programmable payment logic that SPL cannot provide.

**Solana Seeker.** The biometric passport was tested on Seeker specifically — the clearest current signal of Solana's mobile-native developer ecosystem.

---

### 5. Grant Budget

**Total requested: $65,000 USD**

| Item | Amount | Detail |
|---|---|---|
| External security audit — all 8 programs | $50,000 | Targeting OtterSec, Neodyme, or Halborn. ~3–4 week engagement. |
| `dark_bn254_gate` — real Groth16 VK | $7,500 | Remove devnet bypass. Generate VK from production trusted-setup ceremony. |
| `dark_shielded_pool` — Poseidon + ceremony | $5,000 | Replace `IS_STUB=true`. Poseidon hash alignment, recipient binding, multi-party ceremony. |
| Squads v4 multisig migration | $2,500 | Transfer all 8 program upgrade authorities to Squads v4 before audit. |

No salaries, marketing, or token liquidity.

---

### 6. Team

**Parad0x Labs / sls_0x** — solo founder and lead engineer. Scope: Anchor programs, Rust, TypeScript SDK, secp256r1 / SIMD-0075, Groth16 circuits, AES-GCM, CI/CD, adversarial test harnesses.

All 8 mainnet programs, the compression library, and the biometric passport flow were built and deployed solo. Evidence: 8 programs verifiable on mainnet 2026-05-29, biometric passport transactions above, 1990+ tests, 12/12 adversarial scenarios passing.

---

### 7. Honest Disclosures

**`IS_MAINNET_READY=false` on all 8 programs.** Enforcement logic is deliberately fail-open in the current pilot. Audit sign-off is the gate for flipping each program to `true`.

**`dark_bn254_gate` — unconditional bypass present.** The program contains a literal `0xDE 0xAD` bypass: any proof passes. This is a documented P0. The program is excluded from the pilot deployment. Grant deliverable: remove bypass, replace with real VK.

**`dark_shielded_pool` — stub.** `IS_STUB=true` and `MAINNET_READY=false` are public constants. Excluded from pilot. Grant deliverable: complete implementation.

**No external audit.** Internal review, cargo-audit, clippy, and 1990+ tests are not a substitute for an external audit. The audit is the primary grant deliverable.

**Single-key upgrade authority.** Current governance risk; Squads migration is a grant deliverable completed before the audit code freeze.

**Phantom wallet incompatibility.** Phantom's in-app browser does not pass the secp256r1 precompile. Working clients today: Chrome desktop, Mobile Wallet Adapter. Known limitation tracked upstream.

---

### 8. Timeline (3 months)

**Month 1 — Governance and audit preparation**
- Squads v4 multisig migration: all 8 programs, single-key authority retired
- Audit firm engaged; code freeze; full documentation package delivered

**Month 2 — ZK sprint and audit execution**
- Track A: `dark_bn254_gate` — real Groth16 VK from Powers of Tau ceremony
- Track B: `dark_shielded_pool` — Poseidon alignment, recipient binding, ceremony
- Track C: External audit running; findings addressed in real time

**Month 3 — Remediation and sign-off**
- Audit findings remediated; re-audit of critical findings if required
- Per-program `IS_MAINNET_READY=true` flip in order of audit sign-off
- Public audit report (30-day embargo max if firm requires)
- SDK stable release tagged

**Deliverables at grant close:**
- All 8 programs under Squads multisig upgrade authority
- Published external audit report
- `IS_MAINNET_READY=true` for each program cleared by audit
- `dark_bn254_gate`: real VK, bypass removed
- `dark_shielded_pool`: stub replaced, ceremony complete
- SDK stable release tagged
- OSS fork documented for zero-Parad0x-dependency deployment

---

### 9. OSS Commitment

All 8 programs: MIT. Liquefy: MIT. No gating on the OSS fork.

**OSS fork:** `protocolFeeBps = 0`, permissioned, no backend required.
**Commercial rail:** Parad0x operates at `protocolFeeBps = 5` (0.05%). Operators set their own fees (0–2000 bps).

Post-audit, this becomes a reference implementation for any developer building agent-to-agent payments, machine identity systems, or private settlement on Solana. The receipt compression and netting logic is reusable for any high-throughput settlement use case.

---

*Contact: sls_0x — github.com/Parad0x-Labs*
*Repository: github.com/Parad0x-Labs/dna-x402*
*All evidence, test logs, and deployment artifacts in the public repo.*
