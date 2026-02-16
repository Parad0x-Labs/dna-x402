# Devnet Deploy Runbook (Audit Gate)

Date: 2026-02-16  
Workspace: `/Users/sauliuskruopis/Desktop/dark $NULL/dark_null_protocol`

## Non-negotiable note

You cannot transfer mainnet SOL to devnet.  
Devnet SOL must be funded via devnet faucet/airdrops.

- CLI: `solana airdrop <amount> -u devnet`
- Web faucet: [https://faucet.solana.com](https://faucet.solana.com)

## Scripts shipped

From `x402/`:

- `npm run deploy:estimate -- --cluster devnet`
- `npm run deploy:ledger -- --cluster devnet [--dry-run]`
- `npm run deploy:buffers:close -- --cluster devnet`
- `npm run sim:1005 -- --runs 1005 --seed 20260216`
- `npm run sim:10agents`
- `MARKET_ALLOW_DEV_INGEST=0 npm run audit:full -- --cluster devnet --deployer-keypair <KEYPAIR> --upgrade-authority <AUTHORITY>`

These scripts write JSON reports under `/Users/sauliuskruopis/Desktop/dark $NULL/dark_null_protocol/reports`.

## Program selection

Default behavior autodiscovers deploy artifacts from:

- `target/deploy/*.so`

Current workspace has at least:

- `target/deploy/pdx_dark_protocol.so`

You can override with explicit program list:

```bash
cd '/Users/sauliuskruopis/Desktop/dark $NULL/dark_null_protocol/x402'
npm run deploy:ledger -- --cluster devnet \
  --program '/Users/sauliuskruopis/Desktop/dark $NULL/dark_null_protocol/target/deploy/pdx_dark_protocol.so'
```

## Step-by-step

### 1) Create dedicated deployer keypair

```bash
solana-keygen new --outfile '/Users/sauliuskruopis/Desktop/dark $NULL/dark_null_protocol/devnet_deployer.json'
```

Optional separate upgrade authority:

```bash
solana-keygen new --outfile '/Users/sauliuskruopis/Desktop/dark $NULL/dark_null_protocol/devnet_upgrade_authority.json'
```

### 2) Point CLI to devnet and verify address

```bash
solana config set -u devnet
solana address -k '/Users/sauliuskruopis/Desktop/dark $NULL/dark_null_protocol/devnet_deployer.json'
```

### 3) Fund deployer on devnet

```bash
solana airdrop 5 -u devnet -k '/Users/sauliuskruopis/Desktop/dark $NULL/dark_null_protocol/devnet_deployer.json'
solana balance -u devnet -k '/Users/sauliuskruopis/Desktop/dark $NULL/dark_null_protocol/devnet_deployer.json'
```

Repeat as allowed, or top up from faucet.

### 4) Pre-flight deploy estimate

```bash
cd '/Users/sauliuskruopis/Desktop/dark $NULL/dark_null_protocol/x402'
npm run deploy:estimate -- \
  --cluster devnet \
  --keypair '/Users/sauliuskruopis/Desktop/dark $NULL/dark_null_protocol/devnet_deployer.json'
```

### 5) Dry-run deploy ledger (no chain writes)

```bash
cd '/Users/sauliuskruopis/Desktop/dark $NULL/dark_null_protocol/x402'
npm run deploy:ledger -- \
  --cluster devnet \
  --keypair '/Users/sauliuskruopis/Desktop/dark $NULL/dark_null_protocol/devnet_deployer.json' \
  --upgrade-authority '/Users/sauliuskruopis/Desktop/dark $NULL/dark_null_protocol/devnet_upgrade_authority.json' \
  --dry-run
```

### 6) Real deploy with measured cost deltas

```bash
cd '/Users/sauliuskruopis/Desktop/dark $NULL/dark_null_protocol/x402'
npm run deploy:ledger -- \
  --cluster devnet \
  --keypair '/Users/sauliuskruopis/Desktop/dark $NULL/dark_null_protocol/devnet_deployer.json' \
  --upgrade-authority '/Users/sauliuskruopis/Desktop/dark $NULL/dark_null_protocol/devnet_upgrade_authority.json'
```

### 7) Run quality gate + deterministic 1005 simulations

```bash
cd '/Users/sauliuskruopis/Desktop/dark $NULL/dark_null_protocol/x402'
npm run typecheck:x402
npm run test:wow
npm test
npm run sim:1005 -- --runs 1005 --seed 20260216
npm run sim:10agents
MARKET_ALLOW_DEV_INGEST=0 npm run audit:full -- \
  --cluster devnet \
  --deployer-keypair '/Users/sauliuskruopis/Desktop/dark $NULL/dark_null_protocol/devnet_deployer.json' \
  --upgrade-authority '/Users/sauliuskruopis/Desktop/dark $NULL/dark_null_protocol/devnet_upgrade_authority.json'
```

### 8) Rehearse buffer cleanup and reclaim path

```bash
cd '/Users/sauliuskruopis/Desktop/dark $NULL/dark_null_protocol/x402'
npm run deploy:buffers:close -- \
  --cluster devnet \
  --keypair '/Users/sauliuskruopis/Desktop/dark $NULL/dark_null_protocol/devnet_deployer.json' \
  --authority '/Users/sauliuskruopis/Desktop/dark $NULL/dark_null_protocol/devnet_upgrade_authority.json'
```

### 9) Publish evidence bundle

Collect and store:

- deploy estimate JSON
- deploy ledger JSON (dry-run + real)
- buffer close JSON
- simulation JSON
- full audit JSON + `AUDIT_REPORT.md`

All are written to:

- `/Users/sauliuskruopis/Desktop/dark $NULL/dark_null_protocol/reports`

## Audit positions checklist (must pass)

### A. Key and authority safety

- [ ] Dedicated deployer keypair only for devnet deploys
- [ ] Upgrade authority separated from deployer (preferred)
- [ ] Recovery note includes program IDs, buffer accounts, authority owners, close commands

### B. Economic safety

- [ ] Deploy ledger report produced with per-program and total deltas
- [ ] Buffer close report produced at least once (rehearsal)
- [ ] Priority fee defaults stay off unless explicitly set via `--with-compute-unit-price`

### C. Marketplace integrity

- [ ] FAST analytics count fulfilled + payment verified + valid receipt path
- [ ] VERIFIED analytics additionally require `anchored=true` (do not infer from `anchor32` presence alone)
- [ ] `MARKET_ALLOW_DEV_INGEST` remains off by default
- [ ] Publish/order routes have baseline rate limits

### D. Payment verification safety

- [ ] SPL verifier rejects wrong mint/recipient/underpay/fake signatures
- [ ] Stream verifier path exists or UI explicitly marked simulated
- [ ] Quote expiry and stale-proof cases tested

### E. Circuit breakers

- [ ] `PAUSE_MARKET` enforced (`/market/*` and bundle run)
- [ ] `PAUSE_FINALIZE` enforced (`/finalize`)
- [ ] `PAUSE_ORDERS` enforced (`/market/orders*`)
- [ ] Daily/per-call budget caps enforced in SDK policy path

### F. Simulation readiness

- [ ] Deterministic runner executes 1005 scenarios and writes JSON report
- [ ] Includes: quote competition, limit orders, bundle execution, netting path, receipt-chain verification
- [ ] Replay supported by `--seed` + `--only-index`
