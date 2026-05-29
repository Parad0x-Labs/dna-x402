# Solana Foundation Grant Application

## NULL Miner - Decentralized Agent Work Protocol

**Applicant:** Parad0x Labs
**Track:** Developer tooling, agent payments, DePIN infrastructure
**Ask:** Audit funding, target $25,000–$80,000 USD equivalent in SOL
**Stage:** Tested local/devnet-ready stack, mainnet pilot deploy prepared; external audit pending

---

## What We Built — The Confirmed First Claim

> **First Solana implementation combining: (a) x402 micropayment rail, (b) Groth16 private settlement
> with on-chain receipt anchoring, (c) Agent Passport with biometric key binding via WebAuthn/MetaMask —
> in one open-source codebase.**

Prior art note: x402 is an open standard with multiple Solana implementations (Coinbase, Pay.sh,
Solana Foundation). Our specific contribution is the integrated four-layer stack. No competing
open-source project ships all layers together. Three independent AI audits confirmed this scoping.

---

## AI Audit Summary (Three Independent Reviews)

| Auditor | Verdict | Key Finding |
|---|---|---|
| Grok | Pilot-ready | 6 pilot programs are structurally sound; no critical blockers for disclosed devnet pilot. Advises external audit before mainnet enforcement. |
| Local Claude (Haiku) | P0 ZK blockers are NOT in pilot | `dark_bn254_gate` bypass and `dark_shielded_pool` stub are P0 issues, but those programs are not in the 6-program pilot deploy profile. Pilot programs are safe for disclosed testing. |
| GPT Pro | Deploying with correct posture | `IS_MAINNET_READY=false` feature gate is correctly applied. Recommends external audit to activate enforcement. Scoped "first on Solana" claim to four-layer combo — confirmed accurate. |

All three auditors agreed: the 6 pilot programs may be deployed for a disclosed devnet/pilot with
`IS_MAINNET_READY=false`. Production enforcement requires external audit.

---

## Native Solana Programs (6 Pilot Programs)

| Program | Scope |
|---|---|
| `dark_semaphore` | Nullifier registry for agent work proofs |
| `dark_secp256r1_vault` | P-256/WebAuthn passkey vault record with encrypted key material stored in a PDA |
| `dark_secp256k1_auth` | ETH address to Solana agent binding via secp256k1 precompile flow |
| `null_token_hook` | Token-2022 transfer-hook gate for passport/allowlist policy |
| `null_lottery` | Keccak/SHA-256 commit-reveal lottery/root primitive with fallback-draw path |
| `null_mint_gate` | NULL emission claim ledger with nullifier replay protection |

Programs NOT in pilot (post-audit sprint):

| Program | Issue | Status |
|---|---|---|
| `dark_bn254_gate` | 0xDE 0xAD unconditional bypass — anyone forges proof | Not deployed; blocked on ZK sprint |
| `dark_shielded_pool` | `IS_STUB=true`, `MAINNET_READY=false` as pub consts | Not deployed; literal stub |

---

## TypeScript SDK

The SDK covers task loops, Dark Passport identity, x402 receipt anchoring,
passkey-sealed agent key vaults, lottery/root helpers, Liquefy archive payloads,
flywheel emission accounting, privacy helpers, and deployment profiles.

438 TypeScript tests green in the local test suite.

---

## Why This Grant — Two Work Tracks

### Track 1 — ZK Program Fix (60–100 hours)
Fix `dark_bn254_gate` and `dark_shielded_pool` to be production-grade:
- Remove 0xDE 0xAD unconditional bypass; wire real Groth16 verifying key
- Replace `IS_STUB=true` with real Poseidon note commitment + shielded transfer logic
- Achieve Poseidon parity between on-chain and off-chain TypeScript DrawMachine

### Track 2 — External Audit of All 8 Programs (~$30,000–$80,000)
Scope: the 6 pilot programs above + the 2 ZK programs after Track 1 is complete.

This grant request is for **audit funding** — not mainnet production clearance. The programs
deploy today for a disclosed pilot. External audit unlocks `IS_MAINNET_READY=true` enforcement.

---

## The Feature Gate Mechanism

`IS_MAINNET_READY` is a compile-time constant in every program:

```rust
// Currently false in all 6 pilot programs:
const IS_MAINNET_READY: bool = cfg!(feature = "mainnet");
```

- **`IS_MAINNET_READY=false`** (current): pass-through / devnet trust model, no real settlement.
- **`IS_MAINNET_READY=true`** (post-audit): full enforcement — sig verification, SPL mint CPI, lottery settlement.

Flipping to true requires only a `--features mainnet` rebuild after external audit sign-off.
No protocol changes, no new programs, no migration.

---

## Why It Matters for Solana

- Agent payments need low-friction wallets, policy, receipts, and replay-safe accounting.
- The OSS profile (zero fees, zero NULL emission) gives builders a free way to inspect and fork the rail.
- The commercial pilot generates Solana-visible transaction evidence before the external audit is complete, with that status explicitly disclosed.
- NULL token exists on Solana mainnet: `8EeDdvCRmFAzVD4takkBrNNwkeUTUQh4MscRK5Fzpump`.

---

## Traction

- 438 TypeScript tests green in the local SDK test suite
- Six native Solana programs in the pilot deploy profile
- Dual-track deploy (OSS devnet / commercial mainnet pilot) with separate config profiles
- Passkey vault stores encrypted agent key material in a Solana PDA (on-chain, no server dependency)
- Browser/extension/service-worker compatible SDK — works without Node.js
- Mainnet deployment scripts prepared for sequential deployment and config ID stamping

---

## Audit Scope and Estimated Cost

**Target auditors:** Solana-specialized security firms (e.g., Halborn, Neodyme, OtterSec).
**Programs in scope:** Six pilot programs now; two ZK programs after Track 1 fixes.

Focus areas:
- PDA derivation and account validation
- Nullifier replay prevention
- Passkey and secp256k1 precompile verification paths
- Token-2022 hook bypass vectors
- Lottery commit-reveal manipulation resistance
- NULL emission accounting and SPL mint CPI activation

---

## Funding Use

| Item | Amount |
|---|---|
| Professional smart contract audit (6 programs) | $25,000–$40,000 |
| ZK program fixes (Track 1) — dev hours | $5,000–$15,000 |
| Audit of ZK programs (Track 2 extension) | $10,000–$25,000 |
| Mainnet deployment and verification budget | Up to $1,000 equivalent |
| Total target range | $41,000–$81,000 |

---

## Links

- Repository: https://github.com/Parad0x-Labs/dna-x402
- NULL token: `8EeDdvCRmFAzVD4takkBrNNwkeUTUQh4MscRK5Fzpump`
- Deployment guide: [`DEPLOYMENT.md`](./DEPLOYMENT.md)
- License: MIT (`NOTICE` file lists all third-party dependencies)
