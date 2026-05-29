# Solana Foundation Grant Application

## NULL Miner - Decentralized Agent Work Protocol

**Applicant:** Parad0x Labs
**Track:** Developer tooling, agent payments, DePIN infrastructure
**Ask:** Audit funding, target $25,000-$40,000 USD equivalent in SOL
**Stage:** Tested local/devnet-ready stack, mainnet pilot deploy prepared

## What We Built

NULL Miner is an agent-work rail on Solana. Phones, browsers, and servers can
run tasks, produce receipts, route x402 payments, and record proof material
through native Solana programs and a TypeScript SDK.

The stack includes a zero-fee OSS/devnet profile and a commercial mainnet pilot
profile. The same public code can be tested without protocol fees, while the
Parad0x-operated pilot can generate public transaction evidence for audit and
grant review.

## Native Solana Programs

| Program | Scope |
|---|---|
| `dark_semaphore` | Nullifier registry for agent work proofs |
| `dark_secp256r1_vault` | P-256/WebAuthn passkey vault record with encrypted key material stored in a PDA |
| `dark_secp256k1_auth` | ETH address to Solana agent binding via secp256k1 precompile flow |
| `null_token_hook` | Token-2022 transfer-hook gate for passport/allowlist policy |
| `null_lottery` | Poseidon commit-reveal lottery/root primitive with fallback-draw path |
| `null_mint_gate` | NULL emission claim ledger with epoch caps and nullifier replay protection |

## TypeScript SDK

The SDK covers task loops, Dark Passport identity, x402 receipt anchoring,
passkey-sealed agent key vaults, lottery/root helpers, Liquefy archive payloads,
flywheel emission accounting, privacy helpers, and deployment profiles.

## Why It Matters for Solana

- Agent payments need low-friction wallets, policy, receipts, and replay-safe
  accounting.
- The OSS profile gives builders a zero-fee way to inspect and fork the rail.
- The commercial profile gives Solana-visible transaction evidence without
  changing the public code path.
- The audit gate is explicit: `IS_MAINNET_READY` stays false until programs are
  compiled with both `mainnet` and `audit-verified`.

## Traction

- 438 TypeScript tests reported green in the local SDK test suite.
- Six native Solana programs are included in the deploy profile.
- Program keypairs are ignored from git.
- Mainnet deployment scripts are prepared for sequential deployment and config
  ID stamping.
- NULL token exists on Solana mainnet:
  `8EeDdvCRmFAzVD4takkBrNNwkeUTUQh4MscRK5Fzpump`.

## Audit Scope

**Target auditors:** Solana-specialized security firms.
**Estimated cost:** $25,000-$40,000.
**Programs in scope:** Six native Solana programs in the pilot profile.

Focus areas:

- PDA derivation and account validation.
- Nullifier replay prevention.
- Passkey and secp256k1 precompile verification paths.
- Token-2022 hook bypass vectors.
- Lottery root/draw manipulation resistance.
- NULL emission caps and SPL mint CPI activation.

## Funding Use

| Item | Amount |
|---|---|
| Professional smart contract audit | $30,000 target |
| Mainnet deployment and verification budget | Up to $1,000 equivalent |
| Initial capped pilot liquidity and operating buffer | Up to $2,000 equivalent |
| Total target | About $33,000 |

## Links

- Repository: https://github.com/Parad0x-Labs/dna-x402
- NULL token: `8EeDdvCRmFAzVD4takkBrNNwkeUTUQh4MscRK5Fzpump`
- Deployment guide: [`DEPLOYMENT.md`](./DEPLOYMENT.md)
