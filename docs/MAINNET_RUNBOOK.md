# DNA x402 — Mainnet Runbook

**Last updated:** 2026-05-29  
**Cluster:** mainnet-beta  
**Deploy wallet:** `F6Fr2Sn6jLMbpLMcg7ezrwNLZxs9MM8RYyifUAvP72BY`  
**Repo:** https://github.com/Parad0x-Labs/dna-x402

---

## Quick Reference

| Script | Purpose |
|--------|---------|
| `npm run mainnet:preflight` | Safety checks before any mainnet operation |
| `npm run mainnet:deploy:safe` | Wrapped deploy with logging + recovery hints |
| `npm run mainnet:verify` | Confirm all 8 programs are live and executable |
| `npm run mainnet:buffers` | Check for orphaned buffers wasting SOL |
| `npm run mainnet:smoke:receipt` | Read-only proof_gate_lite live check |
| `npm run mainnet:smoke:x402` | Fee computation correctness |
| `npm run mainnet:smoke:usdc` | USDC gate (skipped unless `USDC_SMOKE_ENABLED=1`) |
| `npm run mainnet:mayhem` | 12 adversarial in-process SDK scenarios |
| `npm run mainnet:evidence` | Assemble grant evidence package |
| `npm run mainnet:authority:checklist` | Print current authorities + transfer commands |
| `npm run mainnet:postdeploy:all` | Run all post-deploy checks in sequence |

---

## Deploy Flow

### 1. Pre-deploy checks

```bash
npm run mainnet:preflight
```

This checks:
- Git HEAD == origin/main (no stale local commits)
- Active Solana keypair == deploy wallet (`F6Fr2Sn6jLMbpLMcg7ezrwNLZxs9MM8RYyifUAvP72BY`)
- SOL balance >= 1 SOL
- No keypair JSON files tracked in git
- Both config files exist with correct fee values
- x402 SDK builds and tests pass

### 2. Check for orphaned buffers

```bash
npm run mainnet:buffers
```

Always check for buffers before a new deploy. Orphaned buffers from failed deploys
waste SOL. If any are found, recover them **before** spending more:

```bash
solana program close --buffers -u mainnet-beta
```

### 3. Deploy

```bash
npm run mainnet:deploy:safe
```

This wraps `scripts/deploy/mainnet-commercial.sh` with:
- Timestamped logging to `logs/mainnet/deploy-<timestamp>.log`
- Recovery instructions printed on failure

The deploy script is interactive — type `deploy-mainnet-pilot` when prompted.

### 4. Post-deploy verification

```bash
npm run mainnet:postdeploy:all
```

This runs in sequence:
1. Verify 8 programs live + executable (`evidence/mainnet/programs.json`)
2. Check no orphaned buffers remain
3. Read-only receipt anchor smoke
4. Fee computation smoke (5 scenarios)
5. USDC gate check (skipped unless `USDC_SMOKE_ENABLED=1`)
6. 12 mayhem scenarios
7. Build grant evidence package

---

## Failure Recovery

### Deploy fails mid-run

```bash
# 1. Check buffers immediately
solana program show --buffers -u mainnet-beta

# 2. Close orphaned buffers to recover SOL
solana program close --buffers -u mainnet-beta

# 3. Check remaining balance
solana balance -u mainnet-beta

# 4. Re-run (the deploy script skips already-live programs)
npm run mainnet:deploy:safe
```

### SOL balance critical (< 0.5 SOL)

Stop all deploys. Transfer additional SOL to the deploy wallet before proceeding.
Do NOT attempt a multi-program deploy with < 2 SOL (each program deploy requires ~0.7–1.5 SOL rent).

### RPC errors

The public endpoint `https://api.mainnet-beta.solana.com` can be rate-limited.
Set a premium RPC in configs if needed:

```json
{
  "rpcUrl": "https://YOUR-PREMIUM-RPC.com"
}
```

---

## WHAT NOT TO RUN

**NEVER run this:**
```bash
# THIS DESTROYS A DEPLOYED PROGRAM — IRREVERSIBLE
solana program close <PROGRAM_ID> --bypass-warning
```

This closes a deployed program account. The program ID becomes permanently undeployable.
All funds, state, and program data are lost. It cannot be undone.

**Safe buffer recovery only:**
```bash
# This closes temporary BUFFER accounts, NOT programs
solana program close --buffers -u mainnet-beta
```

---

## Verifying Programs

### Quick check (all 8 via script)

```bash
npm run mainnet:verify
```

Output goes to `evidence/mainnet/programs.json` and `docs/MAINNET_PROGRAMS.md`.

### Manual check (single program)

```bash
solana program show Ev7HEFhhKTXk6kS2Y6ssbUcK9C7E6yZ589jJNjUrQV5p -u mainnet-beta
```

### All 8 program IDs

| Program | ID |
|---------|-----|
| `dark_semaphore` | `Ev7HEFhhKTXk6kS2Y6ssbUcK9C7E6yZ589jJNjUrQV5p` |
| `dark_secp256r1_vault` | `3hbbtjeSrTVYXq6eRwjeofDe2DCPh3n8cfN6kZcQfewi` |
| `dark_secp256k1_auth` | `AqwBbV13AoczhoELwP8oxT3nDqB6MsLWXauNzHkssZ9B` |
| `null_token_hook` | `14ivonrNRmaMbJMQkGdHVVTcqZYhNvchULWxveazhW2g` |
| `null_lottery` | `3t5c2Trk4SFK7hvKVjsmmC2xQtasFnK9pJQRdwPHqxbG` |
| `null_mint_gate` | `5jduvBZggszFeE7uxxNrvZAp8pJxzqtgzBGqg12fKhC1` |
| `receipt_anchor` | `6HSRGivdYR5D7yTDy1TFMCM8h3LzXxRtKU1RA3RnCMRN` |
| `dark_proof_gate_lite` | `PmSCTuehX1MYxf8GNsGsUZySYTtqWAtuTt3N2xZLpw2` |

---

## OSS / Commercial Config Switch

### Use commercial config (50/5 bps fees)

```bash
# Default — already set
# configs/mainnet.commercial.json: operatorFeeBps=50, protocolFeeBps=5
```

### Use OSS config (0/0 fees, grant track)

```bash
# configs/mainnet.oss.json: operatorFeeBps=0, protocolFeeBps=0
# Pass this config to your dnaPaywall options:
dnaPaywall({
  priceAtomic: "1000000",
  recipient: "YOUR_WALLET",
  operatorFeeBps: 0,
  protocolFeeBps: 0,
})
```

The OSS config is the grant-facing proof that the protocol is permissionless and
can run with zero fees. Use it for grant demonstrations.

---

## Smoke Tests

### Receipt anchor (read-only program live check)

```bash
npm run mainnet:smoke:receipt
```

Checks `dark_proof_gate_lite` is live and executable via `getAccountInfo`. Read-only.
No transaction. Output: `evidence/mainnet/smoke-receipt-anchor.json`.

### x402 fee computation smoke

```bash
npm run mainnet:smoke:x402
```

Tests 5 scenarios in-process: commercial fees, OSS zero fees, dust amounts,
address validation. Output: `evidence/mainnet/x402-fee-receipts.json`.

### USDC optional smoke

```bash
# Skipped unless:
USDC_SMOKE_ENABLED=1 npm run mainnet:smoke:usdc
```

Not a launch blocker. USDC is validated in devnet CI.

### Mayhem (12 adversarial scenarios)

```bash
npm run mainnet:mayhem
```

In-process SDK adversarial tests. No transactions.
Output: `evidence/mainnet/mayhem-results.json`.

---

## Grant Evidence Package

```bash
npm run mainnet:evidence
```

Reads all evidence files in `evidence/mainnet/` and produces:
- `evidence/mainnet/MAINNET_BETA_EVIDENCE.json` — comprehensive machine-readable evidence
- `docs/GRANT_EVIDENCE_PACKET.md` — human-readable grant packet
- `docs/MAINNET_BETA_LAUNCH_REPORT.md` — launch status report

---

## Upgrade Authority

Current authority: `F6Fr2Sn6jLMbpLMcg7ezrwNLZxs9MM8RYyifUAvP72BY` (single wallet, pre-audit)

Planned migration to Squads multisig post-audit:

```bash
# Dry run — shows commands without executing
npm run mainnet:authority:checklist

# Execute transfer (requires NEW_AUTHORITY set)
NEW_AUTHORITY=<SQUADS_VAULT_PUBKEY> CONFIRM_TRANSFER=YES bash scripts/post-mainnet/09-transfer-authority-checklist.sh
```

The checklist script:
- Shows current authority for all 8 programs
- Prints exact `solana program set-upgrade-authority` commands
- Verifies authority after each transfer when executing
- Writes `docs/UPGRADE_AUTHORITY.md`
