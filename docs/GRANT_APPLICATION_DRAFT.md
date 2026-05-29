# DNA x402 — Solana Foundation Grant Application

**Applicant:** Parad0x Labs  
**Contact:** sls_0x  
**Repo:** https://github.com/Parad0x-Labs/dna-x402  
**Deploy date:** 2026-05-29  
**Cluster:** mainnet-beta  

---

## Project Title

DNA x402: First Solana x402 Micropayment Protocol for AI Agents — External Audit and Mainnet Hardening

---

## One-Line Description

The first Solana stack combining x402 micropayments, a Groth16 private settlement roadmap, and Agent Passport biometric key binding — 8 programs deployed to mainnet-beta, NULL token live on Token-2022, OSS zero-fee config for permissionless public use.

---

## Technical Achievement (Confirmed First on Solana)

DNA x402 is the first Solana implementation to combine:

1. **x402 HTTP payment protocol** — HTTP 402-based micropayments for AI agents, with a full quote→commit→finalize→receipt flow on Solana/USDC. Agents pay endpoints autonomously, without human-in-the-loop authorization.

2. **Agent price negotiation** — first x402 implementation where agents bid autonomously below the listed price. The server counters at a configurable floor; agents accept or walk. Up to configurable max rounds.

3. **Receipt chain linking** — multi-agent payment graphs. When agent A subcontracts to agent B which subcontracts to agent C, every payment receipt references its parent. The full chain is traversable on-chain via `dark_proof_gate_lite`. First Solana implementation.

4. **Groth16 private settlement roadmap** — `dark_semaphore` and `dark_proof_gate_lite` are deployed with the cryptographic primitives for Semaphore-style zero-knowledge receipt anchoring. Full verifier integration is next sprint.

5. **Agent Passport** — biometric key binding via `dark_secp256r1_vault` (iOS/Android Secure Enclave, WebAuthn) and `dark_secp256k1_auth` (EVM-compatible secp256k1). Agents authenticate with device biometrics, no seed phrase exposure.

6. **OSS zero-fee config** — both operator and protocol fees are 0 in `configs/mainnet.oss.json`. The protocol is permissionless and forkable with no extractive intermediation.

---

## What Is Deployed

8 programs on mainnet-beta:

| Program | ID | Role |
|---------|-----|------|
| `dark_semaphore` | `Ev7HEFhhKTXk6kS2Y6ssbUcK9C7E6yZ589jJNjUrQV5p` | ZK nullifier / Semaphore-style group membership |
| `dark_secp256r1_vault` | `3hbbtjeSrTVYXq6eRwjeofDe2DCPh3n8cfN6kZcQfewi` | secp256r1 key vault (WebAuthn / Secure Enclave) |
| `dark_secp256k1_auth` | `AqwBbV13AoczhoELwP8oxT3nDqB6MsLWXauNzHkssZ9B` | secp256k1 auth (EVM-compatible agent identity) |
| `null_token_hook` | `14ivonrNRmaMbJMQkGdHVVTcqZYhNvchULWxveazhW2g` | Token-2022 transfer hook for NULL emission |
| `null_lottery` | `3t5c2Trk4SFK7hvKVjsmmC2xQtasFnK9pJQRdwPHqxbG` | On-chain NULL token lottery |
| `null_mint_gate` | `5jduvBZggszFeE7uxxNrvZAp8pJxzqtgzBGqg12fKhC1` | Epoch-gated NULL minting |
| `receipt_anchor` | `6HSRGivdYR5D7yTDy1TFMCM8h3LzXxRtKU1RA3RnCMRN` | Receipt PDA anchoring |
| `dark_proof_gate_lite` | `PmSCTuehX1MYxf8GNsGsUZySYTtqWAtuTt3N2xZLpw2` | Proof gate for receipt chain verification |

**NULL token:** `8EeDdvCRmFAzVD4takkBrNNwkeUTUQh4MscRK5Fzpump` (Token-2022, live)

---

## Fee Model

| Track | operatorFeeBps | protocolFeeBps | Notes |
|-------|---------------|----------------|-------|
| Commercial | 50 (0.5%) | 5 (0.05%) | Parad0x's own default for Parad0x-run endpoints. Third-party builders set operator fee freely. |
| OSS / Grant | 0 | 0 | Zero fees, permissionless, forkable. For grant proof and public use. |

Fees are enforced at the SDK/receipt-metadata level today. On-chain fee-split enforcement is Sprint 2 scope and is a direct deliverable of this grant.

**No backend custody. No backend signing.** Payments go directly on-chain: payer → recipient. Parad0x never touches user funds.

---

## Audit Status (honest disclosure)

All 8 programs are deployed with `IS_MAINNET_READY=false` in the program binary. This flag is a compile-time guard that prevents full production settlement before an external audit approves each program.

The current deployment is a **capped pilot**: controlled endpoint builders, limited exposure, monitored.

**What has been done:**
- Internal technical review
- Automated static analysis
- Adversarial mayhem test suite (12 scenarios, documented in `docs/MAINNET_MAYHEM_REPORT.md`)
- Devnet full-loop CI (`devnet-smoke` job)
- Buffer cleanup verification
- No backend custody

**What is pending:**
- External security audit by a reputable Solana program auditing firm
- `IS_MAINNET_READY=true` flag activation per-program on audit sign-off
- Squads multisig migration for upgrade authority

---

## Grant Ask

**Total requested:** [amount to be determined based on audit quotes]

**Breakdown:**

| Item | Description |
|------|-------------|
| External security audit | Full audit of all 8 programs by a reputable Solana auditing firm. Prerequisite for `IS_MAINNET_READY=true` and public mainnet launch. |
| Mainnet hardening | Address findings from audit. Estimated 4–8 weeks engineering. |
| On-chain fee-split enforcement | Sprint 2: transaction-level USDC output splitting to fee recipients. Eliminates trust in SDK metadata for fee distribution. |

---

## Why This Deserves Funding

**Ecosystem contribution:**

1. DNA x402 is an open payment standard — not a proprietary product. The OSS config (zero fees) proves it. Any developer can deploy the SDK with `operatorFeeBps: 0, protocolFeeBps: 0` and run a fully free payment rail.

2. AI agents are the next major Solana consumer. x402 solves the core UX problem: agents can pay for services autonomously, without human wallet approval, at sub-cent granularity, with verifiable receipts.

3. The Agent Passport (secp256r1 + secp256k1 programs) enables biometric-authenticated agents — the first on Solana. Users authorize agents with Face ID / Touch ID, not seed phrases.

4. Receipt chain linking enables multi-agent economic graphs that are auditable on-chain. This is new infrastructure for Solana that does not exist elsewhere.

**Why audit funding specifically:**

An unaudited protocol cannot responsibly enable `IS_MAINNET_READY=true` and expand to general public use. The audit is the critical path bottleneck. Without grant funding, the audit timeline slips while the technical work sits ready to ship.

---

## Deliverables

| Milestone | Deliverable |
|-----------|-------------|
| Audit complete | Audit report published, all critical/high findings resolved |
| Mainnet hardening | Patched program builds with IS_MAINNET_READY=true (per-program on sign-off) |
| On-chain fee split | Sprint 2 fee enforcement, documented and tested |
| Multisig migration | Upgrade authority transferred to Squads multisig, documented |
| Public launch | OSS/commercial configs published, builder quickstart updated |

---

## Team

**Parad0x Labs** — independent builder, operating since 2025.

The codebase demonstrates deep Solana program expertise: Token-2022 hooks, secp256r1 native program invocation, on-chain proof PDAs, x402 SDK, agent negotiation protocol, receipt chain graphs.

---

## Evidence

All deployment evidence is in this repository:

- `evidence/mainnet/MAINNET_BETA_EVIDENCE.json` — comprehensive machine-readable deploy evidence
- `evidence/mainnet/programs.json` — verified program states
- `evidence/mainnet/mayhem-results.json` — adversarial test results
- `docs/GRANT_EVIDENCE_PACKET.md` — human-readable evidence summary
- `docs/MAINNET_PROGRAMS.md` — program table with explorer links
- `docs/FEES_AND_OSS_TRACK.md` — fee model explanation
- `docs/MAINNET_RUNBOOK.md` — deploy and recovery runbook

Explorer links for all programs: see `docs/MAINNET_PROGRAMS.md` or
`evidence/mainnet/MAINNET_BETA_EVIDENCE.json` → `explorerLinks`.
