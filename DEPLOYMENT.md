# Deployment Guide

## Two Tracks

| | OSS Devnet | Commercial Mainnet Pilot |
|---|---|---|
| Fees | Zero | 0.5% config |
| NULL emission | Disabled | 5% accounting config |
| `IS_MAINNET_READY` | `false` | `false` until post-audit rebuild with `--features mainnet` |
| License | MIT | MIT code, Parad0x-operated deployment |
| Cost | Devnet airdrop | Budget 8 SOL wallet, expect lower permanent rent |

---

## Per-Program Risk at `IS_MAINNET_READY=false`

| Program | Behaviour when `IS_MAINNET_READY=false` | Pilot risk |
|---|---|---|
| `dark_semaphore` | Signature verification skipped; nullifier PDA still written | Low — nullifier registry only, no token movement |
| `dark_secp256r1_vault` | P-256 assertion not verified on-chain; PDA still written | Low — devnet trust model, no funds at risk |
| `dark_secp256k1_auth` | ETH sig not verified on-chain; binding PDA still written | Low — devnet trust model, no funds at risk |
| `null_token_hook` | Permissive pass-through up to `dark_pool_limit_atomic` | Low — existing NULL token is standard SPL; Token-2022 hooks cannot be registered on it |
| `null_lottery` | Commit-reveal draw recorded; SPL token settlement skipped | Low — no real currency moves in this mode |
| `null_mint_gate` | Emission claim PDA written; SPL mint CPI skipped | Low — accounting only, no NULL actually minted |

All enforcement activates only when programs are rebuilt with `--features mainnet` **after external audit sign-off**.

Programs NOT in pilot (blocked on ZK sprint, do not deploy):

| Program | Blocker |
|---|---|
| `dark_bn254_gate` | 0xDE 0xAD unconditional bypass — P0, anyone forges proof |
| `dark_shielded_pool` | `IS_STUB=true` and `MAINNET_READY=false` are pub consts — literal stub |

---

## Current Safety Boundary

Commercial mainnet deployment means program accounts are deployed on mainnet and
configured for the commercial profile. It does not mean externally audited
production settlement is active.

Mainnet pilot status must be stated plainly:

- not audited externally yet
- internal technical review, automated analysis tools, and cumulative regression tests completed
- external audit planned; `IS_MAINNET_READY=true` requires post-audit rebuild with `--features mainnet`
- real SOL is spent during deploy
- pilot users and integrators accept smart contract risk before external audit completion

The enforcement gate flips only when programs are rebuilt after audit:

```bash
cargo build-sbf --manifest-path programs/<program>/Cargo.toml --features mainnet
```

Do not flip `IS_MAINNET_READY=true` until the external audit and final code review are complete.

---

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

---

## OSS Devnet Deploy

```bash
solana airdrop 10 --url devnet
chmod +x scripts/deploy/devnet-oss.sh
./scripts/deploy/devnet-oss.sh
node scripts/init/init-all-programs.ts --profile devnet.oss
```

The init helper currently prints deterministic instruction payloads for review.
It does not send transactions.

---

## Commercial Mainnet Pilot Deploy

```bash
chmod +x scripts/deploy/mainnet-commercial.sh
./scripts/deploy/mainnet-commercial.sh
node scripts/init/init-all-programs.ts --profile mainnet.commercial
```

The deploy script:

- Builds only the six pilot programs with `--features mainnet`.
- Deploys sequentially so upload buffers can close between programs.
- Writes deployed program IDs into `configs/mainnet.commercial.json`.
- All programs compile with `IS_MAINNET_READY=false` until post-audit rebuild.

The init helper currently prints deterministic instruction payloads for review.
It does not send transactions.

---

## Mainnet Cost Model

With a wallet funded around 8–10 SOL, the expected permanent cost is program
rent plus transaction fees. Upload buffers should close and return unused SOL
after each sequential deploy. Exact cost depends on final binary sizes and
network fees at deploy time.

Do not assume the script spent correctly until every deployed program is checked:

```bash
solana program show <PROGRAM_ID> -u mainnet-beta
```

---

## Security Notes

- `scripts/keypairs/**/*.json` is gitignored; never commit private keypairs.
- Mainnet upgrade authority should move to a multisig after deploy.
- Commercial profile parameters are not a substitute for audited settlement.
- Mainnet pilot language must disclose that external audit is pending.
- `null_mint_gate` records emission claims pre-audit; SPL mint CPI remains gated.
- `null_lottery` records roots/draws pre-audit; token settlement remains gated.
- `dark_bn254_gate` and `dark_shielded_pool` are excluded from the pilot deploy profile; do not deploy them.
