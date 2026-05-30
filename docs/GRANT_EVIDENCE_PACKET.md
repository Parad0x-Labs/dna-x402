# DNA x402 — Grant Evidence Packet

**Generated:** 2026-05-30T18:16:22.593Z
**Commit:** `9b58f2271640d9cf3fd19d05a083e4830c38812d`
**Cluster:** mainnet-beta
**Deploy Wallet / Protocol Treasury:** `F6Fr2Sn6jLMbpLMcg7ezrwNLZxs9MM8RYyifUAvP72BY`
**Repo:** https://github.com/Parad0x-Labs/dna-x402

---

## Executive Summary

DNA x402 is the first Solana stack combining:
- **x402 micropayments** — HTTP 402 payment protocol for AI agents
- **Groth16 private settlement roadmap** — zk-proof based settlement (dark_semaphore / dark_proof_gate_lite)
- **Agent Passport** — biometric key binding via secp256r1 (iOS/Android Secure Enclave) and secp256k1 (EVM)

8 programs are deployed to Solana mainnet-beta. NULL token is live on Token-2022.

---

## Deployed Programs (mainnet-beta)

| Program | ID | Explorer |
|---------|-----|---------|
| `dark_semaphore` | `Ev7HEFhhKTXk6kS2Y6ssbUcK9C7E6yZ589jJNjUrQV5p` | [Explorer](https://explorer.solana.com/address/Ev7HEFhhKTXk6kS2Y6ssbUcK9C7E6yZ589jJNjUrQV5p?cluster=mainnet-beta) |
| `dark_secp256r1_vault` | `3hbbtjeSrTVYXq6eRwjeofDe2DCPh3n8cfN6kZcQfewi` | [Explorer](https://explorer.solana.com/address/3hbbtjeSrTVYXq6eRwjeofDe2DCPh3n8cfN6kZcQfewi?cluster=mainnet-beta) |
| `dark_secp256k1_auth` | `AqwBbV13AoczhoELwP8oxT3nDqB6MsLWXauNzHkssZ9B` | [Explorer](https://explorer.solana.com/address/AqwBbV13AoczhoELwP8oxT3nDqB6MsLWXauNzHkssZ9B?cluster=mainnet-beta) |
| `null_token_hook` | `14ivonrNRmaMbJMQkGdHVVTcqZYhNvchULWxveazhW2g` | [Explorer](https://explorer.solana.com/address/14ivonrNRmaMbJMQkGdHVVTcqZYhNvchULWxveazhW2g?cluster=mainnet-beta) |
| `null_lottery` | `3t5c2Trk4SFK7hvKVjsmmC2xQtasFnK9pJQRdwPHqxbG` | [Explorer](https://explorer.solana.com/address/3t5c2Trk4SFK7hvKVjsmmC2xQtasFnK9pJQRdwPHqxbG?cluster=mainnet-beta) |
| `null_mint_gate` | `5jduvBZggszFeE7uxxNrvZAp8pJxzqtgzBGqg12fKhC1` | [Explorer](https://explorer.solana.com/address/5jduvBZggszFeE7uxxNrvZAp8pJxzqtgzBGqg12fKhC1?cluster=mainnet-beta) |
| `receipt_anchor` | `6HSRGivdYR5D7yTDy1TFMCM8h3LzXxRtKU1RA3RnCMRN` | [Explorer](https://explorer.solana.com/address/6HSRGivdYR5D7yTDy1TFMCM8h3LzXxRtKU1RA3RnCMRN?cluster=mainnet-beta) |
| `dark_proof_gate_lite` | `PmSCTuehX1MYxf8GNsGsUZySYTtqWAtuTt3N2xZLpw2` | [Explorer](https://explorer.solana.com/address/PmSCTuehX1MYxf8GNsGsUZySYTtqWAtuTt3N2xZLpw2?cluster=mainnet-beta) |

**Upgrade Authority (all programs):** `F6Fr2Sn6jLMbpLMcg7ezrwNLZxs9MM8RYyifUAvP72BY`
**Planned post-audit:** Transfer to Squads multisig

---

## NULL Token

| Field | Value |
|-------|-------|
| Mint | `8EeDdvCRmFAzVD4takkBrNNwkeUTUQh4MscRK5Fzpump` |
| Standard | Token-2022 |
| Explorer | [link](https://explorer.solana.com/address/8EeDdvCRmFAzVD4takkBrNNwkeUTUQh4MscRK5Fzpump?cluster=mainnet-beta) |

---

## Fee Model

| Track | operatorFeeBps | protocolFeeBps | Notes |
|-------|---------------|----------------|-------|
| Commercial | 50 (0.5%) | 5 (0.05%) | Parad0x's own default; each builder sets operator fee freely |
| OSS / Grant | 0 | 0 | Zero-fee, permissionless, forkable |

Fee enforcement: SDK/receipt-level metadata (on-chain split is Sprint 2).
No backend custody. No backend signing. Direct on-chain payments.

---

## Smoke Test Results

| Test | Result |
|------|--------|
| Receipt Anchor Smoke | passed |
| x402 Fee Receipts    | PASS |
| USDC Smoke           | skipped |
| Mayhem (12 scenarios)| ALL PASS |

---

## Known Limitations (disclosed)

1. External security audit not yet completed. `IS_MAINNET_READY=false` in all binaries.
2. On-chain fee-split enforcement is Sprint 2 (current: SDK/receipt metadata).
3. Single-wallet upgrade authority → Squads multisig migration post-audit.
4. Groth16 private settlement on roadmap (programs deployed, full verifier integration pending).

---

## Grant Ask

**Funding requested for:** External audit + mainnet hardening + on-chain fee-split enforcement

**Why this matters:** DNA x402 is an open, permissionless payment rail for AI agents on Solana.
The OSS config (zero fees) demonstrates the protocol is public infrastructure, not extractive middleware.
An audit enables responsible mainnet expansion and formally enables `IS_MAINNET_READY=true`.

---

## Evidence Files

| File | Description |
|------|-------------|
| `evidence/mainnet/MAINNET_BETA_EVIDENCE.json` | This document (machine-readable) |
| `evidence/mainnet/programs.json` | Program verification results |
| `evidence/mainnet/smoke-receipt-anchor.json` | Read-only program live check |
| `evidence/mainnet/x402-fee-receipts.json` | Fee computation smoke tests |
| `evidence/mainnet/usdc-smoke.json` | USDC gate check |
| `evidence/mainnet/mayhem-results.json` | 12 adversarial SDK scenarios |
