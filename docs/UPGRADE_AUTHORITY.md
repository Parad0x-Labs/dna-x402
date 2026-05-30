# Upgrade Authority Status

_Generated: 2026-05-30T22:14:29Z_

## Current State

| Program | Program ID | Current Authority |
|---------|-----------|------------------|
| `dark_semaphore` | `Ev7HEFhhKTXk6kS2Y6ssbUcK9C7E6yZ589jJNjUrQV5p` | `9M949AfyYCHp9hUk7crZZx3N6Y8sigyWBN6RM6tFq1q5` |
| `dark_secp256r1_vault` | `3hbbtjeSrTVYXq6eRwjeofDe2DCPh3n8cfN6kZcQfewi` | `9M949AfyYCHp9hUk7crZZx3N6Y8sigyWBN6RM6tFq1q5` |
| `dark_secp256k1_auth` | `AqwBbV13AoczhoELwP8oxT3nDqB6MsLWXauNzHkssZ9B` | `9M949AfyYCHp9hUk7crZZx3N6Y8sigyWBN6RM6tFq1q5` |
| `null_token_hook` | `14ivonrNRmaMbJMQkGdHVVTcqZYhNvchULWxveazhW2g` | `9M949AfyYCHp9hUk7crZZx3N6Y8sigyWBN6RM6tFq1q5` |
| `null_lottery` | `3t5c2Trk4SFK7hvKVjsmmC2xQtasFnK9pJQRdwPHqxbG` | `9M949AfyYCHp9hUk7crZZx3N6Y8sigyWBN6RM6tFq1q5` |
| `null_mint_gate` | `5jduvBZggszFeE7uxxNrvZAp8pJxzqtgzBGqg12fKhC1` | `9M949AfyYCHp9hUk7crZZx3N6Y8sigyWBN6RM6tFq1q5` |
| `receipt_anchor` | `6HSRGivdYR5D7yTDy1TFMCM8h3LzXxRtKU1RA3RnCMRN` | `9M949AfyYCHp9hUk7crZZx3N6Y8sigyWBN6RM6tFq1q5` |
| `dark_proof_gate_lite` | `PmSCTuehX1MYxf8GNsGsUZySYTtqWAtuTt3N2xZLpw2` | `9M949AfyYCHp9hUk7crZZx3N6Y8sigyWBN6RM6tFq1q5` |

## Planned Migration

Transfer all upgrade authorities to a **Squads multisig** vault after external audit completion.

### Steps

1. Create Squads multisig at [app.squads.so](https://app.squads.so) with protocol signers.
2. Note the vault pubkey (not the squad address — the vault that holds upgrade authority).
3. Run with confirmation:
   ```bash
   NEW_AUTHORITY=<SQUADS_VAULT_PUBKEY> CONFIRM_TRANSFER=YES bash scripts/post-mainnet/09-transfer-authority-checklist.sh
   ```
4. Verify each program's authority using `solana program show`.
5. Test upgrade path in devnet with new authority before mainnet.

### Safety Notes

- **NEVER** run `solana program close <PROGRAM_ID>` — destroys programs
- Transfer to multisig before expanded public use
- Keep a hot-wallet emergency keypair accessible for critical patches (until multisig operational)
