# DNA x402 Secrets Inventory

This document tracks where operational secrets live without storing the secret values in git.

Raw secrets, private keys, wallet keypairs, database URLs, API keys, bot tokens, and passphrases must not be committed to git. Private GitHub is not a vault. Use the encrypted export script in this repo or a real team vault.

## Current Local Secret Files

| Area | Local path | Contains | Git status | Restore target |
| --- | --- | --- | --- | --- |
| Polymarket builder lab | `x402/labs/polymarket-phase0/.env.local` | Polymarket builder code, builder API key, secret, passphrase, relayer URL, CLOB URL, RPC URL, owner signer source | ignored | same path |
| Mainnet x402 drill keys | `x402/test-mainnet/keys/mainnet/ALL_KEYS.json` | Mainnet generated key material for test/drill actors | ignored | same path |
| Mainnet deployer | `x402/test-mainnet/keys/mainnet/deployer.json` | Mainnet Solana deployer keypair | ignored | same path |
| Mainnet runtime env | `x402/test-mainnet/keys/mainnet/runtime.env` | Mainnet drill/runtime env, RPC, recipient, signing/admin secrets, keypair paths | ignored | same path |
| Devnet x402 drill keys | `x402/test-mainnet/keys/devnet/ALL_KEYS.json` | Devnet generated key material for test/drill actors | ignored | same path |
| Devnet deployer | `x402/test-mainnet/keys/devnet/deployer.json` | Devnet Solana deployer keypair | ignored | same path |
| Devnet runtime env | `x402/test-mainnet/keys/devnet/runtime.env` | Devnet drill/runtime env, RPC, recipient, signing/admin secrets, keypair paths | ignored | same path |
| NULL direct split treasury display key | `x402/test-mainnet/keys/solana-usdc-drill/treasury-display.json` | DNA fee treasury/display keypair used by the Solana USDC drill path | ignored | same path |
| Deploy staging temp key | `x402/.tools/tmp/dnp-deploy-stage/deployer.json.1ac1af645942.json` | Temporary copied deployer key from deployment staging | ignored | same path |

## Known Secret Variable Names

Polymarket phase-0 lab:

- `POLYMARKET_PHASE0_ALLOW_MUTATION`
- `POLYMARKET_PHASE0_ENVIRONMENT`
- `POLYMARKET_RELAYER_URL`
- `POLYMARKET_CLOB_API_URL`
- `POLYMARKET_RPC_URL`
- `POLYMARKET_OWNER_SIGNER_SOURCE`
- `POLYMARKET_BUILDER_CODE`
- `POLYMARKET_BUILDER_API_KEY`
- `POLYMARKET_BUILDER_SECRET`
- `POLYMARKET_BUILDER_PASSPHRASE`

x402 mainnet/devnet runtime:

- `ADMIN_SECRET`
- `ALLOW_INSECURE`
- `ANCHORING_BATCH_SIZE`
- `ANCHORING_ENABLED`
- `ANCHORING_FLUSH_INTERVAL_MS`
- `ANCHORING_IMMEDIATE`
- `ANCHORING_KEYPAIR_PATH`
- `ANCHORING_SIGNATURE_LOG_PATH`
- `AUDIT_FIXTURES`
- `CLUSTER`
- `GAUNTLET_FUNDER_KEYPAIR`
- `GAUNTLET_MODE`
- `HELIUS_RPC`
- `MAINNET_DEPLOYER_KEYPAIR`
- `PAYMENT_RECIPIENT`
- `PORT`
- `RECEIPT_ANCHOR_PROGRAM_ID`
- `RECEIPT_SIGNING_SECRET`
- `SOLANA_RPC_URL`
- `UNSAFE_UNVERIFIED_NETTING_ENABLED`
- `USDC_MINT`

## Backup

Create an encrypted local archive:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\secrets\export-encrypted-secrets.ps1
```

The script prompts for a passphrase and writes an encrypted archive under `.local-secrets-backups/`. That directory is ignored by git.

## Restore

Restore an encrypted local archive:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\secrets\restore-encrypted-secrets.ps1 -ArchivePath ".\.local-secrets-backups\<archive>.secrets.zip.enc"
```

The restore script decrypts to a temporary folder, shows the manifest, and asks for confirmation before copying files back into place.

## Rules

- Commit this inventory and the helper scripts.
- Do not commit plaintext `.env`, keypair JSON, private keys, tokens, SSH keys, database URLs, Telegram tokens, Helius keys, or Polymarket credentials.
- Do not commit encrypted archives unless a separate decision is made and the passphrase is stored outside git.
- Rotate any secret that ever appears in plaintext git history.
