# STEP 2–4 SUMMARY (MAINNET)

## Step 2: Cost Plan
- Status: PASS
- Artifacts:
  - `audit_out_mainnet/deploy_estimate_mainnet.json`
  - `audit_out_mainnet/MAINNET_COST_PLAN.md`

Key totals:
- ProgramData rent deposit: 1.838776320 SOL
- With one-buffer-per-program contingency + fee budget: 3.678052640 SOL

## Step 3: Authority Plan
- Status: PASS
- Mode: NEW_DEPLOY
- Artifact:
  - `audit_out_mainnet/authority_plan.json`

## Step 4: Deploy + Reclaim
- Status: FAIL (stopped)
- Failure point: first program deploy (`receipt_anchor`)
- Error: insufficient funds for spend (0.59625624 SOL) + fee (0.000445 SOL)
- Deployer starting balance: 0 SOL
- Artifact:
  - `audit_out_mainnet/deploy_ledger_mainnet.json`

## Stopped Actions (due to hard stop on fail)
- Buffer close step was not executed.
- `program_show_mainnet_*.txt` files were not generated.

## Required Next Action
- Fund deployer wallet on mainnet and re-run Step 4.
