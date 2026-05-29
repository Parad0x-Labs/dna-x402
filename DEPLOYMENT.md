# Deployment Guide

## Two Tracks

| | OSS Devnet | Commercial Mainnet Pilot |
|---|---|---|
| Fees | Zero | 0.5% config |
| NULL emission | Disabled | 5% accounting config |
| `IS_MAINNET_READY` | `false` | `false` until audit-verified build |
| License | MIT | MIT code, Parad0x-operated deployment |
| Cost | Devnet airdrop | Budget 8 SOL wallet, expect lower permanent rent |

## Current Safety Boundary

Commercial mainnet deployment means program accounts are deployed on mainnet and
configured for the commercial profile. It does not mean third-party audited
production settlement is active.

Mainnet pilot status must be stated plainly:

- no completed third-party audit yet
- reviewed internally by developers with automated analysis tools and cumulative regression tests
- third-party audit planned before `audit-verified` activation
- real SOL is spent during deploy
- pilot users and integrators accept unaudited smart contract risk

The enforcement gate flips only when programs are built with both features:

```bash
cargo build-sbf --manifest-path programs/<program>/Cargo.toml --features mainnet,audit-verified
```

Do not use the `audit-verified` feature until the audit and final code review are
complete. The default commercial pilot deploy script builds without that feature.

## Prerequisites

```bash
node --version
solana --version
cargo --version
solana address
solana balance -u mainnet-beta
```

Required before spending SOL:

- Clean git worktree.
- Remote branch contains the commit being deployed.
- Solana CLI explicitly uses `mainnet-beta` for deploy commands.
- Deploy wallet has enough SOL for rent and buffer uploads.
- Program keypairs are backed up and not committed.
- Existing mainnet programs are checked with `solana program show` before any redeploy.

## OSS Devnet Deploy

```bash
solana airdrop 10 --url devnet
chmod +x scripts/deploy/devnet-oss.sh
./scripts/deploy/devnet-oss.sh
node scripts/init/init-all-programs.ts --profile devnet.oss
```

The init helper currently prints deterministic instruction payloads for review.
It does not send transactions.

## Commercial Mainnet Pilot Deploy

```bash
chmod +x scripts/deploy/mainnet-commercial.sh
./scripts/deploy/mainnet-commercial.sh
node scripts/init/init-all-programs.ts --profile mainnet.commercial
```

The deploy script:

- Builds only the six pilot programs.
- Deploys sequentially so upload buffers can close between programs.
- Writes deployed program IDs into `configs/mainnet.commercial.json`.
- Leaves `IS_MAINNET_READY=false` because `audit-verified` is not enabled.

The init helper currently prints deterministic instruction payloads for review.
It does not send transactions.

## Mainnet Cost Model

With a wallet funded around 8-10 SOL, the expected permanent cost is program
rent plus transaction fees. Upload buffers should close and return unused SOL
after each sequential deploy. Exact cost depends on final binary sizes and
network fees at deploy time.

Do not assume the script spent correctly until every deployed program is checked:

```bash
solana program show <PROGRAM_ID> -u mainnet-beta
```

## Security Notes

- `scripts/keypairs/**/*.json` is gitignored; never commit private keypairs.
- Mainnet upgrade authority should move to a multisig after deploy.
- Commercial profile parameters are not a substitute for audited settlement.
- Mainnet pilot language must say "unaudited" until a third-party audit is complete.
- `null_mint_gate` records emission claims pre-audit; SPL mint CPI remains gated.
- `null_lottery` records roots/draws pre-audit; token settlement remains gated.
