# DNA x402 — Mainnet-Beta Launch Report

**Date:** 2026-05-29
**Commit:** `e3c6cd1349766ecb539a8d4308ecb98d675f6bf4`
**Generated:** 2026-05-29T18:52:35.255Z

---

## What Was Deployed

8 Solana programs deployed to mainnet-beta on 2026-05-29.

| Program | Program ID |
|---------|-----------|
| `dark_semaphore` | `Ev7HEFhhKTXk6kS2Y6ssbUcK9C7E6yZ589jJNjUrQV5p` |
| `dark_secp256r1_vault` | `3hbbtjeSrTVYXq6eRwjeofDe2DCPh3n8cfN6kZcQfewi` |
| `dark_secp256k1_auth` | `AqwBbV13AoczhoELwP8oxT3nDqB6MsLWXauNzHkssZ9B` |
| `null_token_hook` | `14ivonrNRmaMbJMQkGdHVVTcqZYhNvchULWxveazhW2g` |
| `null_lottery` | `3t5c2Trk4SFK7hvKVjsmmC2xQtasFnK9pJQRdwPHqxbG` |
| `null_mint_gate` | `5jduvBZggszFeE7uxxNrvZAp8pJxzqtgzBGqg12fKhC1` |
| `receipt_anchor` | `6HSRGivdYR5D7yTDy1TFMCM8h3LzXxRtKU1RA3RnCMRN` |
| `dark_proof_gate_lite` | `PmSCTuehX1MYxf8GNsGsUZySYTtqWAtuTt3N2xZLpw2` |

**NULL token:** `8EeDdvCRmFAzVD4takkBrNNwkeUTUQh4MscRK5Fzpump` (Token-2022, live)

---

## Deploy Configuration

| Parameter | Value |
|-----------|-------|
| Cluster | mainnet-beta |
| Deploy wallet | `F6Fr2Sn6jLMbpLMcg7ezrwNLZxs9MM8RYyifUAvP72BY` |
| Upgrade authority | `F6Fr2Sn6jLMbpLMcg7ezrwNLZxs9MM8RYyifUAvP72BY` (single wallet, pre-audit) |
| Planned multisig | Squads — post-audit |
| IS_MAINNET_READY | false (pre-audit pilot) |
| Audit status | External audit pending |

---

## Remaining SOL Post-Deploy

~6.91 SOL in deploy wallet. Program rent deposits held in program accounts.

---

## What Works

- x402 payment middleware (`dnaPaywall`): quote → commit → finalize → receipt
- Agent price negotiation (first Solana x402 implementation)
- Receipt chain linking (multi-agent payment graphs)
- Session keys (pay-once, use-multiple middleware)
- Fee split SDK enforcement (operator + protocol)
- On-chain program accounts: all 8 programs executable on mainnet-beta
- NULL token: Token-2022 mint live
- **Dark Passport Tiers 0–2** — wallet-bound identity live in frontend
  - Tier 0: Phantom-signed device identity (active)
  - Tier 1: P-256/WebAuthn passkey → `dark_secp256r1_vault` (live on-chain, UI wired)
  - Tier 2: MetaMask/ETH binding → `dark_secp256k1_auth` (live on-chain, UI wired)
  - Tier 3: ZK reputation (Sprint 2 — Groth16 circuits)
- **Real mainnet write smoke** — `dark_proof_gate_lite` RecordVerifiedClaim confirmed on-chain
  - TX: `8owZaj13aCbFNYqsRhUdxgBfRDFsr4SDeJqPn5FLZmUh3xCmzSJ2PkX4iwxQAUxZUNyGdkrA3bouLXs456p2tAS`

---

## What Is Explicitly Sprint 2

- On-chain fee-split enforcement (transaction-level USDC splits)
- Squads multisig upgrade authority migration
- External security audit
- Groth16 private settlement full integration
- `IS_MAINNET_READY=true` flag activation per-program (requires audit sign-off)

---

## Risk Management

- All programs deployed with `IS_MAINNET_READY=false` — settlement gated
- Pre-audit capped pilot: limited to controlled endpoint builders
- No backend custody — payments go directly on-chain
- Upgrade authority retained for emergency patches
- Buffer cleanup verified before deploy

---

## Next Steps

1. External security audit (grant-funded target)
2. Squads multisig migration for upgrade authority
3. Activate `IS_MAINNET_READY=true` per-program on audit sign-off
4. On-chain fee-split enforcement (Sprint 2)
5. Public mainnet open beta announcement
