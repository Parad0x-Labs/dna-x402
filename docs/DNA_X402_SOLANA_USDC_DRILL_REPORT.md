# DNA x402 Solana USDC Drill Report

Status: `PRIVATE_STAGING_TECHNICAL_CHAIN_PROOF_PASSED`

This report is the required evidence packet for a private, allowlisted, dust-size Solana USDC chain drill. It is not a public production launch packet.

Historical note: the original strict Solana USDC drill was run under the older private-staging label. Current product launch label is Public Beta. Historical drill status remains valid as technical evidence, not unlimited public production approval.

## Drill Statement

This was a private staging drill, not public production launch.

## Approved Next Step

The codebase is approved for a private staging dust-size Solana USDC drill only.

This is not public production, not a live marketplace launch, not approval for public fee collection, and not approval for Polymarket live movement.

## Required Inputs Before Drill

Collect these values before starting the staging server and copy them into the drill record after the run:

- buyer allowlisted wallet
- seller allowlisted wallet
- treasury public wallet
- named pause/operator wallet
- staging server URL
- Solana cluster / RPC URL
- USDC mint address
- max transaction amount
- daily drill cap
- emergency pause contact

## Immediate Drill Inputs Needed

Fill these before staging starts:

| Input | Value |
| --- | --- |
| Buyer wallet | `CmGCjBZLqHZzeBk8nTxe4CgrJcXLJz3BBvAEMni3qezv` |
| Seller/recipient wallet | `ETdR88B6ZVeBu3L5fNAmj9PbXEifSEQjASAx9w4YtCbb` |
| Treasury public wallet | `8fWzmPQhRMnkZo6k26XaywAFgbhHF6FRyTnBwZ6P3N9u` |
| Pause/operator wallet | Public Beta operator assigned; final wallet/account reference kept outside public repo |
| Emergency contact | `DNA x402 Ops Alerts` / Saulius |
| Staging URL | `127.0.0.1` ephemeral private drill server |
| Solana cluster | `mainnet-beta` |
| RPC URL | `https://api.mainnet-beta.solana.com` for completed strict proof; use `HELIUS_RPC` or `HELIUS_API_KEY` for any longer mainnet drill. |
| USDC mint | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |
| Max tx amount | `100000` atomic USDC (`0.10 USDC`) |
| Daily cap | `500000` atomic USDC (`0.50 USDC`) |

## Operator Rule

One named person must be watching the drill and able to trigger emergency pause immediately.

## Drill Label

Original pre-Postgres label was:

> Private staging Solana USDC technical chain proof - not production readiness evidence.

Updated label after live Postgres and monitoring evidence:

> Private staging Solana USDC technical chain proof passed. Public production remains blocked pending counsel review, public-production backup operators, direct split fee gate review, and explicit live-gate approvals.

## Scope Locks

- Public marketplace: disabled
- Production money movement gate: locked
- Unattended signing: disabled
- Backend private key custody: forbidden
- Public netting: disabled
- Physical goods: disabled
- High-risk categories: disabled
- Polymarket live movement: disabled
- Auto-sweep: disabled
- Hidden fee: forbidden

## Allowed Drill Scope

Allowed:

- 1-3 low-risk sandbox listings
- allowlisted wallets only
- dust-size USDC payments only
- manual buyer signing only
- signed quote
- commit
- SPL transfer proof
- finalize
- receipt
- paid retry
- fee waterfall display/accrual
- emergency pause test
- audit export

Not allowed:

- public marketplace
- public seller onboarding
- live Polymarket movement
- unattended signing
- backend private keys
- backend custody
- auto-sweep
- SOL-equivalent fee threshold
- direct split collection outside the approved Public Beta direct split gate
- physical goods
- high-risk categories
- public netting

## Drill Amount Limits

- Per payment: `0.01-0.10 USDC`
- Daily total cap: `1-5 USDC`
- Max wallets: `2-5` internal wallets
- Max duration: `1-2` days

## Preconditions

| Item | Status | Evidence |
| --- | --- | --- |
| Live Postgres drill passed | `PASSED_G_LOCAL_POSTGRES_18` | G-local PostgreSQL 18 migration, health, concurrency, native `pg_dump` backup, and `psql` restore drills passed after the initial chain proof. |
| Emergency pause tested | `LOCAL_PASSED` | Covered by server tests and mayhem. |
| Server mayhem passed | `LOCAL_PASSED` | `npm run mayhem:x402:server` passed with HTTP attack checks. |
| Hard PII guard active | `LOCAL_PASSED` | Immutable receipt/audit/webhook PII tests pass. |
| Backend private key scan passed | `LOCAL_PASSED` | `npm --prefix x402 run security:scan` passed. |
| Private key env vars rejected | `LOCAL_PASSED` | Gate/security tests cover private-key custody rejection. |
| Live gates locked | `LOCAL_PASSED` | Runtime gate tests pass. |
| Allowlisted wallets configured | `PASSED` | Buyer signer allowlist enforced. Non-allowlisted signer proof rejected in strict report. |
| Low-risk listing category | `PASSED` | Used core `/resource` paid API sandbox listing only. |
| Receipt verification works | `LOCAL_PASSED` | Receipt tests and paid retry tests pass. |
| Rollback/pause operator assigned | `ASSIGNED_PUBLIC_BETA` | Saulius assigned as Public Beta emergency pause operator in `docs/DNA_X402_OPERATOR_ASSIGNMENTS.md`; public-production backup remains pending. |

## Required Runtime Config

```txt
NODE_ENV=staging
X402_ENABLE_REAL_CHAIN_DRILL=1
X402_ENABLE_PROD_MONEY=0
X402_ENABLE_PUBLIC_MARKETPLACE=0
X402_ENABLE_UNATTENDED_SIGNING=0
X402_ENABLE_BACKEND_KEY_CUSTODY=0
X402_ENABLE_PUBLIC_NETTING=0
X402_ENABLE_PHYSICAL_GOODS=0
X402_ENABLE_HIGH_RISK_CATEGORIES=0
X402_ENABLE_POLYMARKET_LIVE=0
X402_REAL_CHAIN_ALLOWED_SIGNERS=<comma-separated internal buyer signer wallets>
X402_REAL_CHAIN_MAX_TX_ATOMIC=100000
X402_REAL_CHAIN_DAILY_CAP_ATOMIC=5000000
X402_REAL_CHAIN_FEE_MODE=display_only
X402_REAL_CHAIN_PLATFORM_FEE_BPS=10
X402_REAL_CHAIN_PLATFORM_RECIPIENT=<treasury-public-wallet>
FEE_BPS=0
HELIUS_RPC=<preferred full Helius endpoint, redacted in reports>
# or:
HELIUS_API_KEY=<preferred Helius API key, never written to reports>
```

Notes:

- `FEE_BPS=0` avoids collecting a hidden fee through the seller recipient.
- `X402_REAL_CHAIN_FEE_MODE=display_only` shows the 10 bps fee in the waterfall but does not collect it.
- Approved Public Beta direct split now uses canonical `X402_PLATFORM_FEE_MODE=direct_split`, `X402_ENABLE_DIRECT_SPLIT_FEES=1`, and `X402_DIRECT_SPLIT_GATE_REF`, not hidden seller-recipient collection.
- The drill runner prefers `HELIUS_RPC`, then `HELIUS_API_KEY`, then `SOLANA_RPC_URL`, then public RPC. Helius docs list the mainnet RPC endpoint shape as `https://mainnet.helius-rpc.com/?api-key=YOUR_API_KEY`.
- Public `direct_split` remains blocked until counsel review, public-production backup operators, and explicit live-gate approval are complete.
- No auto-sweep or SOL-equivalent threshold is allowed.

## Drill Flow

1. Start staging server.
2. Confirm dangerous gates are disabled.
3. Confirm allowlisted wallets are configured.
4. Confirm treasury public wallet is configured.
5. Confirm named pause/operator wallet is configured.
6. Confirm no backend private key env vars are accepted.
7. Publish one low-risk listing.
8. Request quote.
9. Confirm quote shows amount, token/mint, recipient, expiry, settlement mode, policy state, fee waterfall, and the active 10 bps mode: display, accrual, or approved Public Beta direct split.
10. Commit quote.
11. Buyer signs and sends tiny USDC payment manually.
12. Submit SPL transfer proof.
13. Finalize.
14. Verify receipt.
15. Retry paid endpoint.
16. Confirm fulfillment.
17. Try replay proof.
18. Try wrong recipient proof.
19. Try wrong mint proof.
20. Try underpay.
21. Toggle emergency pause.
22. Confirm new quote/finalize is blocked.
23. Confirm old receipt remains readable.
24. Export audit log.
25. Fill this report.

## Drill Record

| Field | Value |
| --- | --- |
| Date/time | `PENDING` |
| Staging server URL | `PENDING` |
| Network | `PENDING` |
| RPC URL | `PENDING` |
| Token mint | `PENDING` |
| Buyer allowlisted wallet | `CmGCjBZLqHZzeBk8nTxe4CgrJcXLJz3BBvAEMni3qezv` |
| Seller allowlisted wallet | `ETdR88B6ZVeBu3L5fNAmj9PbXEifSEQjASAx9w4YtCbb` |
| Treasury public wallet | `8fWzmPQhRMnkZo6k26XaywAFgbhHF6FRyTnBwZ6P3N9u` |
| Pause/operator wallet | `Public Beta operator assigned; final wallet/account reference kept outside public repo` |
| Emergency pause contact | `DNA x402 Ops Alerts / Saulius` |
| Recipient wallet | `ETdR88B6ZVeBu3L5fNAmj9PbXEifSEQjASAx9w4YtCbb` |
| Amount | `50000` atomic USDC (`0.05 USDC`) |
| Max transaction amount | `100000` atomic USDC (`0.10 USDC`) |
| Daily drill cap | `500000` atomic USDC (`0.50 USDC`) |
| Transaction signature | `5iDsqW4FnkocW9Tak2M1u47nMJZpy9Z1yYdv3YjQnVdcWZ2PY2cZGxqevmGzbUQ2TwWmab9pix6tMPcWZ9qZsQcA` |
| Quote ID | `3b543915-18d4-46fc-8751-07b6cd5c6c5d` |
| Commit ID | `e85358f4-df61-46de-bcd1-dd77b495e858` |
| Receipt ID | `d3c34b07-2b19-411f-8c6e-0d04aa77c1f9` |
| Verifier result | `PASSED` |
| Receipt verification result | `PASSED` |
| Paid retry result | `PASSED` |
| Emergency pause result | `Covered by server mayhem; not toggled during live dust transfer run.` |
| Audit export path | `G:\DNA x402\reports\solana-usdc-drill\2026-05-15T10-56-38-257Z.json` |
| Screenshots/log snippets | `See report JSON and tx links below.` |
| Failures and fixes | First run had RPC-rate-limited semantic negative checks; runner was tightened to retry RPC-limited checks until exact semantic errors were proven. |

## Funding Check

| Checked At | Buyer Wallet | SOL Balance | USDC Balance | Notes |
| --- | --- | --- | --- | --- |
| 2026-05-15 | `CmGCjBZLqHZzeBk8nTxe4CgrJcXLJz3BBvAEMni3qezv` | `0.129109767 SOL` | `0 USDC` | SOL landed for gas/rent. Canonical Solana USDC is still pending before the USDC payment-path drill can run. |
| 2026-05-15 | `CmGCjBZLqHZzeBk8nTxe4CgrJcXLJz3BBvAEMni3qezv` | `0.129119767 SOL` | `2.774415 USDC` | Funding is green for a private dust-size Solana USDC drill. Remaining inputs are seller/recipient wallet, treasury public wallet, pause/operator wallet, staging URL, RPC URL, max tx amount, and daily cap. |

## Executed Mainnet Dust Proof

Latest strict report:

- Report path: `G:\DNA x402\reports\solana-usdc-drill\2026-05-15T10-56-38-257Z.json`
- Valid payment tx: `https://solscan.io/tx/5iDsqW4FnkocW9Tak2M1u47nMJZpy9Z1yYdv3YjQnVdcWZ2PY2cZGxqevmGzbUQ2TwWmab9pix6tMPcWZ9qZsQcA`
- Non-allowlisted signer tx: `https://solscan.io/tx/47LrLGdArv1KcRSd1iduQ9zEYXB6PD24ZDD1Tc3Y2Y5taJtpEmdvLNWHkCJ2LN4gqyqDp5DAD97jmtiwCfGeNf8f`
- Receipt ID: `d3c34b07-2b19-411f-8c6e-0d04aa77c1f9`
- Receipt hash: recorded in the report JSON.
- Paid retry: passed.
- Replay/different quote: rejected with `X402_REPLAY_DETECTED`.
- Non-allowlisted signer: rejected with `X402_VERIFICATION_FAILED`.
- Underpay: rejected with `X402_UNDERPAY`.
- Wrong recipient: rejected with `X402_WRONG_RECIPIENT`.
- Wrong mint: rejected with `X402_WRONG_MINT`.
- Fee accrual: `50` atomic USDC (`0.00005 USDC`) recorded as `ACCRUED_NOT_COLLECTED`.
- Auto-sweep: not present.
- Backend custody: not present.

RPC note: the public Solana RPC endpoint returned repeated `429 Too Many Requests` responses during proof checks. The strict rerun still passed after retrying RPC-limited verifier checks. A paid/high-throughput RPC is required before any longer mainnet drill. Configure this with `HELIUS_RPC` or `HELIUS_API_KEY`; report artifacts redact the key.

## Executed Direct Split Dust Proof

Status: `PUBLIC_BETA_DIRECT_SPLIT_DUST_PROOF_PASSED`

Latest direct split report:

- Report path: `G:\DNA x402\reports\solana-usdc-drill\2026-05-16T07-11-01-352Z-direct-split.json`
- RPC source: `HELIUS_API_KEY`
- RPC high-throughput: `true`
- Buyer wallet: `CmGCjBZLqHZzeBk8nTxe4CgrJcXLJz3BBvAEMni3qezv`
- Seller/provider wallet: `ETdR88B6ZVeBu3L5fNAmj9PbXEifSEQjASAx9w4YtCbb`
- DNA treasury wallet: `8fWzmPQhRMnkZo6k26XaywAFgbhHF6FRyTnBwZ6P3N9u`
- Gross amount: `10000` atomic USDC (`0.01 USDC`)
- Provider amount: `9990` atomic USDC (`0.00999 USDC`)
- DNA 10 bps fee: `10` atomic USDC (`0.00001 USDC`)
- Provider tx: `https://solscan.io/tx/3BKjypmC1f1tr6nccToQhQpxcDh1Qr4eqaimBvL5z6DdmVbB9NaUZKDr25kPWrtukM9NnU8TZwmEXRE6zMVtYJxY`
- DNA treasury tx: `https://solscan.io/tx/qarpuSinFGrHBUx7Ap6Hfg9wzJBbhuNMU8xj6SGWMENzxZFU6jo18pkAfdRST9mP5sB6pMrR8m6u6fLEccvtmiX`

Checks passed:

- direct split finalize: passed
- receipt verification: passed
- paid retry: passed
- DNA fee status: `COLLECTED_DIRECT_SPLIT`
- split proofs bound into receipt: passed
- fee waterfall hash bound into receipt: passed
- hidden legacy fee: absent
- missing DNA proof: rejected
- wrong DNA treasury recipient: rejected
- underpaid DNA treasury proof: rejected
- replay: rejected
- auto-sweep: absent
- backend custody: absent

Classification:

This proves gated Public Beta direct split collection for low-risk, allowlisted, dust-size Solana USDC flows. It does not approve public direct fee collection, public production launch, direct builder fee collection, auto-sweep, backend custody, Polymarket live movement, public netting, physical goods, or high-risk categories.

## Helius RPC Patch Accepted

Status: `ACCEPTED`

Helius RPC support is approved for the next longer private mainnet drill.

RPC resolution order:

1. `HELIUS_RPC`
2. `HELIUS_API_KEY`
3. `SOLANA_RPC_URL`
4. public Solana RPC fallback

Required rule:

- reports must redact API keys
- public Solana RPC must not be used for longer mainnet mayhem
- missing Helius config should warn clearly
- fallback to public RPC is acceptable only for tiny/manual proof, not extended drills

Before the next longer mainnet drill:

```powershell
$env:HELIUS_API_KEY="your-key"
npm --prefix x402 run drill:solana-usdc -- --yes-real-mainnet-drill
```

or:

```powershell
$env:HELIUS_RPC="https://mainnet.helius-rpc.com/?api-key=your-key"
npm --prefix x402 run drill:solana-usdc -- --yes-real-mainnet-drill
```

Fee status:

- 10 bps direct split collection is implemented and tested for approved Public Beta low-risk flows only
- public direct split collection remains blocked until counsel review, public-production backup operators, and explicit live-gate approval are complete
- auto-sweep, backend fee-wallet custody, SOL-equivalent fee thresholds, and hidden fee collection remain forbidden

Verdict: Helius fixes the RPC bottleneck. It does not remove any production blockers. Live Postgres and monitoring alert routing have since passed; remaining external blockers are counsel review, public-production backup operators, direct split fee gate review, and explicit live-gate approvals.

## Pass Condition

The drill passes only if:

- allowlisted wallet can complete payment
- non-allowlisted wallet is rejected
- payment verifies correctly
- SPL proof verifies correctly
- underpay fails
- wrong mint fails
- wrong recipient fails
- replay fails
- proof-for-different-quote fails
- receipt verifies
- paid retry works
- fee waterfall is visible
- no hidden fee is collected
- no auto-sweep exists
- emergency pause blocks new activity
- old receipts remain readable
- audit trail is complete
- no backend private keys are present
- no live gate accidentally unlocks

## After Drill

Update:

- `docs/DNA_X402_SOLANA_USDC_DRILL_REPORT.md`
- `docs/DNA_X402_MODULAR_COMMERCE_AUDIT_PACKET.md`
- `docs/DNA_X402_LIVE_GATE_CHECKLISTS.md` only if evidence changes a gate status

Keep production status as:

> Private staging Solana USDC drill ready / running. Public production remains blocked pending counsel review, public-production backup operators, direct split fee gate review, and explicit live-gate approvals.

Updated post-drill status:

> Private staging Solana USDC technical chain proof passed. Public production remains blocked pending counsel review, public-production backup operators, direct split fee gate review, and explicit live-gate approvals.

Updated direct split post-drill status:

> Private staging Solana USDC direct split dust proof passed. DNA x402 collected the gated 10 bps DNA treasury fee through a separate buyer-signed SPL transfer and issued a receipt only after both provider and DNA treasury proofs verified. Public direct fee collection remains blocked pending counsel review, public-production backup operators, explicit direct split fee gate approval, and production launch approval.

## Current Verdict

Private staging Solana USDC drill readiness: yes.

Public production readiness: no.

10 bps fee support: display/accrual plus approved Public Beta direct split.

Direct split collection: implemented for approved Public Beta DNA 10 bps flows only; public direct split remains blocked.

Auto-sweep: no.

Next real blocker after drill: counsel review, public-production backup operators, direct split fee gate review, and explicit live-gate approvals.

This private staging Solana USDC technical chain proof passed. It must not be used as public-production approval unless counsel review, public-production backup operators, direct split fee gate review, and explicit live-gate approvals are complete.
