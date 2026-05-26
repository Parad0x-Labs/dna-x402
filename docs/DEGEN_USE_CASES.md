# Dark Null Degen-Native Use Cases

> "If you ape first and think later, Dark Null is your infrastructure."

![Status: NOT_PRODUCTION](https://img.shields.io/badge/status-NOT__PRODUCTION-red) Devnet design only. No audit. mainnet_ready = false.

---

## Overview

All Dark Null primitives organized by degen use case.

| Primitive | What It Does | How A Degen Uses It Daily | Risk Removed |
|-----------|-------------|--------------------------|--------------|
| dark-alpha-receipts | Commit-then-reveal trade proofs | Sell alpha without leaking wallet or mint | Front-run by copy-bots |
| dark-swarm-capsule | Sealed-bid relayer selection | Route through the cheapest relayer without trusting it | Relayer censorship / fee theft |
| dark-compressed-leaves | ZK-compressed receipt storage schema (Light Protocol v2 adapter design — integration planned) | Model shows 10k receipts for ~0.02 SOL (projected) | Rent blowout on large receipt sets |
| dark-meme-risk | Wash-trade and rug risk scoring model (live oracle endpoint not yet deployed) | Score a token before aping — hash-only, no raw mint in receipt | Aping a zero-liquidity wash rug |
| dark-fee-optimizer | P-token + compression fee savings model (live routing not yet wired) | Project CU and rent savings before committing to a route | Paying legacy CU rates on bulk ops |
| ritual-blink-gateway | Payment-gated Blink transaction | Embed a paid action in a tweet link | Free-riders on ritual state transitions |
| rent-sweeper-swarm | Sweep zombie accounts for rent | Wake up idle wallets and recover lamports | Lamports locked in dead accounts |
| bounty-blink-jobs | Blink-based micro-bounty board | Post or claim a task for 0.001 SOL | Unpaid off-chain handshake coordination |
| cold-route-fee-sniper | Scan cold routes for fee arbitrage | Find underpriced routes before bots | Paying market rate on every hop |
| no-deploy-token-launcher | Launch tokens without redeployment | New token, no new program deploy | Paying 2–5 SOL deploy cost per token |
| scratch-slot-leasing | Lease temp account slots | Short-term compute scratch without permanent rent | Paying permanent rent for temp compute |
| shape-pool-pass | Gated pool access via commitment proof | Enter a shape pool with a zero-knowledge ticket | Open front-run on pool entry |
| useful-chaff-market | Buy/sell useful chaff emissions | Monetize required dark chaff output | Chaff cost with zero revenue |
| copy-sniper-trap-board | Publish honeypot commitment feeds | Bait copy-bots into fake signals | Copy-bots eating into your fills |
| ritual-puzzle-market | Sell on-chain puzzle solutions | Post a hash puzzle, sell the solution reveal | Puzzle solutions leaking for free |
| fee-cashback-receipts | Mint CU refund receipts | Accumulate refund receipts from optimized ops | Paying full CU on every optimized route |
| sleep-earn-watcher | Watch for claimable positions overnight | Claim expired positions while you sleep | Claimable lamports left on the table |
| degen-scoreboard | On-chain PnL leaderboard (bucketed) | Rank yourself without leaking exact PnL | Exact PnL exposure to adversaries |
| degen-swarm-demo | End-to-end swarm demo harness | Run the full stack in one command | Integration confusion across crates |

---

## The 6 Frontier Edge Use Cases

### 1. Anti-Copytrading Alpha Receipts (`dark-alpha-receipts`)

**What it does:** Lets an alpha-seller prove historical trades and PnL without leaking their execution wallet or raw token identity. Trade details are locked behind an x402 micro-payment reveal.

**Daily scenario:** You ape into a low-cap token at 9:47 AM. Before submitting the swap, you post the commitment_hash to your Telegram channel — subscribers see you called something, but not what. By noon the token is 4x. You sell, then charge 0.001 SOL per reveal. Subscribers pay, receive the token_hash and trade side, verify it matches your timestamp. You've proved alpha without ever publishing your wallet or the raw mint until after the move. Copy-bots watching your wallet got nothing actionable before price moved.

**Risk prevented:** Copy-bots mirroring your wallet before your trade settles; alpha leak from DEX indexer surveillance.

**Crate:** `crates/dark-alpha-receipts`

---

### 2. Swarm Capsules (`dark-swarm-capsule`)

**What it does:** Sealed-bid relayer selection using commitment hashes. Traders commit to a relayer choice before revealing it, preventing relayer censorship or fee-sniping.

**Daily scenario:** You need to route a large swap through one of five competing relayers. You commit to your relayer choice with a capsule_hash before broadcasting — none of the other relayers know you chose relayer 3. You open the capsule on-chain, the swap routes through relayer 3, and the other four relayers had no window to front-run or censor. Next day you pick a different relayer without penalty — the capsule scheme gives you fresh anonymity each round.

**Risk prevented:** Relayer censorship of specific wallet addresses; fee-sniping by competing relayers who know your routing preference in advance.

**Crate:** `crates/dark-swarm-capsule`

---

### 3. ZK-Compressed Leaves (`dark-compressed-leaves`)

**What it does:** Defines the leaf hash schema for ZK-compressed storage of Dark Null receipts, commitments, and nullifier sets — compatible with Light Protocol v2 leaf format. Actual Light Protocol state tree integration (deploying a tree, submitting leaves via Light SDK) is a planned next step. Rent cost modeled at 99.8% cheaper than full account storage per leaf based on published Light Protocol benchmarks.

**Daily scenario (projected — Light integration not yet live):** You run a paid alpha community with 500 subscribers. Each subscriber gets a TradeReveal per trade; you publish 20 trades a day. That's 10,000 reveals per day. At full account cost that's ~8.9 SOL/day in rent. With ZK compression (modeled): ~0.02 SOL/day. After 30 days projected savings: roughly 266 SOL in rent alone. These are cost projections from published Light Protocol v2 benchmarks, not measurements from a live compressed state tree.

**Risk prevented:** Rent blowout on large-scale receipt operations; economic unviability of high-frequency micro-payment systems at full account cost.

**Crate:** `crates/dark-compressed-leaves`

---

### 4. Meme Risk Oracle (`dark-meme-risk`)

**What it does:** Models a private hash-only risk scoring system for Solana tokens. Implements the MemeTrans (arXiv:2602.13480) weighted signal formula: dev concentration 25%, bundle snipes 25%, wash trades 30%, LP concentration 20%. Token identity stored as SHA256 hash only — no raw mint in any receipt. The crate implements the scoring logic and receipt schema. A live oracle endpoint (hosted server accepting x402 payments) is the next deployment step — not yet running.

**Daily scenario (design prototype — no live endpoint yet):** New token drops at 7 AM. Before you ape, you call the dark-meme-risk oracle with the token hash (not raw mint). You receive a RiskReport: risk_band = High, wash_trade signal elevated, bundle_snipe_count = 18. You pass. The token hash is never logged in a way that links you to the query — the receipt stores only SHA256(token_mint). Tomorrow you check a different token: risk_band = Low, dev_concentration under 20%, few bundle snipes — you ape. Once the oracle endpoint is live and accepting x402 payments, this flow requires one x402 call before every new position.

**Risk prevented:** Aping into wash-traded zero-liquidity tokens; holder concentration rugs; paying full position size to learn a token is fake.

**Crate:** `crates/dark-meme-risk`

---

### 5. Fee Optimizer (`dark-fee-optimizer`)

**What it does:** Models Dark Null token operation costs under the p-token (SIMD-0266) account format and ZK compression, using published on-chain benchmarks. The crate computes projected savings to inform routing and migration decisions. It does not execute live p-token transfers or submit compressed leaves — those paths are the next activation step.

**Daily scenario (projected — not a live route):** Your receipt-minting contract runs 50,000 TransferChecked operations per day for a subscriber base. Legacy SPL Token: 6,200 CU × 50,000 = 310M CU/day. Modeled p-token path: 111 CU × 50,000 = 5.55M CU/day. Projected savings: 304M CU/day — enough to fit 60x more operations into the same block budget. Combined with modeled ZK-compressed receipt storage, projected total cost reduction exceeds 98%. These are model outputs from `dark-fee-optimizer`, not measurements from a live optimized system.

**Risk prevented:** CU budget exhaustion on high-frequency operations; economic unviability of micro-payment infrastructure at legacy CU rates.

**Crate:** `crates/dark-fee-optimizer`

---

### 6. Ritual Blink Gateway (`ritual-blink-gateway`)

**What it does:** Embeds a payment-gated Solana Blink transaction in a shareable URL (tweet link, Discord message, etc.). Clicking the link triggers an x402 payment before the ritual transaction is constructed.

**Daily scenario:** You're running a ritual state transition — a smart contract that advances a shared game state when someone pays. You post a Blink URL to Twitter: "Click to advance the ritual — costs 0.001 SOL." Anyone who clicks and pays gets a signed ritual transaction constructed for their wallet. Free-riders who try to call the contract directly without going through the Blink gateway fail the payment gate check. You collect 0.001 SOL per participant, the ritual advances, and your Twitter thread becomes a payment-collecting deployment mechanism with zero backend servers.

**Risk prevented:** Free-rider exploitation of ritual state transitions; need for backend servers to gate contract interactions; inability to monetize on-chain game mechanics via social media.

**Crate:** `crates/ritual-blink-gateway`

---

## The 13 Degen Swarm Economy Use Cases

### rent-sweeper-swarm
You've been on Solana for two years and you have 47 accounts with dust balances and zero activity. Each holds ~0.002 SOL in rent. The rent-sweeper-swarm scans your wallet graph, identifies all closeable accounts, batches the close instructions, and sweeps the lamports back to your main wallet. One command, one transaction bundle, you recover 0.094 SOL you forgot existed. Run it monthly as a maintenance sweep.

### bounty-blink-jobs
You need someone to write a specific Anchor instruction test. You don't want to post on Upwork. You create a Blink-based bounty: task hash, reward amount, acceptance criteria hash. Post the Blink URL to CT. First person to submit a valid solution (verified on-chain against the criteria hash) claims the SOL. No escrow service. No off-chain handshake. The Blink link is the job board and the payment system.

### cold-route-fee-sniper
Most DEX aggregators optimize for best price output. cold-route-fee-sniper optimizes for lowest fee on a given output target. It scans routes that are currently underpriced due to low utilization — pools that haven't been touched in 10+ minutes, AMM curves with low recent volume. For large swaps where the fee difference matters, this can save 5–15 bps per trade. On 100 SOL daily volume that's real money.

### no-deploy-token-launcher
Standard Solana token launch requires deploying a new program or at minimum a new mint account with full initialization. no-deploy-token-launcher uses a factory pattern: one deployed program handles all new token mints. New token = new mint PDA derived from a factory seed. No new bytecode deployment. No 2–5 SOL deploy cost. Launch a new experiment token for 0.01 SOL in account rent, abandon it if it doesn't work, try again. Iteration speed goes from hours to seconds.

### scratch-slot-leasing
Some computations need temporary account space — sorting buffers, intermediate state, accumulation arrays. These don't need to live forever but currently you pay permanent rent. scratch-slot-leasing lets you lease a pre-allocated scratch account for N slots, use it for your computation, then return it to the pool. You pay a micro-fee for the lease period instead of permanent rent. Ideal for single-transaction compute that needs more account space than CPI allows.

### shape-pool-pass
Shape pools gate entry by requiring a commitment proof that a wallet has held a specific token composition for a minimum period. shape-pool-pass generates the commitment proof locally, submits it with a zero-knowledge ticket, and the pool verifies eligibility without the pool operator ever learning which specific token composition you hold. Entry is gated but not surveillance-gated. Your portfolio composition stays private.

### useful-chaff-market
Dark chaff emissions are required by the nullifier bank system — you must emit some volume of chaff to maintain privacy properties. useful-chaff-market turns this cost center into a revenue line: other participants can purchase your required chaff emissions as dummy transaction cover for their own operations. You get paid for what you'd emit anyway. Buyers get their required traffic cover. The market price is set by supply and demand.

### copy-sniper-trap-board
You suspect copy-bots are watching your wallet. copy-sniper-trap-board lets you publish a honeypot commitment feed — realistic-looking commitment hashes that resolve to fake or zero-value trade reveals. Copy-bots that follow the feed and pay for reveals get nothing actionable. They can't distinguish the honeypot feed from a real one until they've wasted resources on reveals. Meanwhile your actual trades go through your real commitment feed under a different session.

### ritual-puzzle-market
Post a SHA-256 hash puzzle on-chain with a SOL reward. Anyone who finds the preimage collects the reward. ritual-puzzle-market is the primitive for turning any hash-preimage problem into a paid computation market. Use cases include: password cracking bounties for your own forgotten keys, proof-of-work coordination for testnet events, computation verification games. The puzzle poster defines the reward; solvers compete.

### fee-cashback-receipts
Every time a Dark Null operation runs through the fee optimizer and saves CU versus the legacy path, a fee-cashback-receipt is minted recording the saved amount. Accumulate enough receipts and they can be redeemed for priority access to low-fee routing windows, discounted oracle queries, or future protocol fee rebates. It's a loyalty program for on-chain efficiency — the more you optimize, the more you earn back.

### sleep-earn-watcher
Some DeFi positions expire, unlock, or become claimable on a schedule that doesn't care about your timezone. sleep-earn-watcher monitors a list of positions and auto-claims them when they become available — no keeper bot required, no server running. It runs as a scheduled x402 relay job: pays itself from the claimed proceeds, sends the remainder to your wallet. Wake up with more SOL than you went to sleep with.

### degen-scoreboard
A bucketed, commitment-masked PnL leaderboard. Traders submit PnlCommitment proofs for their epoch performance. The scoreboard ranks them by PnL bucket without revealing exact amounts or wallet addresses. You know rank 1 had "Whale positive" performance; you don't know their wallet or their exact PnL. Subscribers pay 0.001 SOL to unlock one trader's full reveal set. The scoreboard is public; the details are paywalled.

### degen-swarm-demo
End-to-end integration demo harness that spins up all major Dark Null primitives in a single devnet run. One command launches: a trader session, a swarm capsule selection, a commitment chain, a meme risk oracle query, a fee optimizer route, and a Blink gateway interaction. Output is a structured JSON report showing all component outputs and verification results. Use this to smoke-test a full stack integration before writing any of your own code against the crates.

---

## If You're a Degen and You Hate:

- **Getting front-run by copy-bots** → use `dark-alpha-receipts`
- **Paying 6,200 CU for a basic token transfer** → use `dark-fee-optimizer` with p-token routing
- **Storing 10,000 receipts for 8.9 SOL** → use `dark-compressed-leaves`
- **Aping a rug because you didn't check** → use `dark-meme-risk` first (costs 0.001 SOL)
- **Relayers censoring your transactions** → use `dark-swarm-capsule` for sealed relayer selection
- **Running backend servers to gate contract access** → use `ritual-blink-gateway`
- **Lamports rotting in zombie accounts** → use `rent-sweeper-swarm`
- **Off-chain handshake drama for micro-tasks** → use `bounty-blink-jobs`
- **Paying 2–5 SOL every time you launch an experiment token** → use `no-deploy-token-launcher`
- **Permanent rent for temporary compute** → use `scratch-slot-leasing`
- **Your portfolio composition being visible to pool operators** → use `shape-pool-pass`
- **Paying for dark chaff with zero return** → sell it on `useful-chaff-market`
- **Copy-bots eating your edge** → bait them with `copy-sniper-trap-board`
- **Puzzle solutions leaking to free-riders** → gate them with `ritual-puzzle-market`
- **Not getting rewarded for running efficient ops** → collect `fee-cashback-receipts`
- **Missing claimable positions while sleeping** → automate with `sleep-earn-watcher`
- **Leaking exact PnL to your competition** → use the bucketed `degen-scoreboard`
- **Integration confusion across 10+ crates** → start with `degen-swarm-demo`

---

## NOT This

Dark Null is NOT a mixer and does NOT mix funds. No coin mixing. No transaction graph breaking.

Dark Null is NOT a money laundering tool. Commitment-reveal privacy is one-way hash unlinkability, not a financial privacy network.

Dark Null does NOT guarantee profit, returns, yield, or income of any kind. All use cases involve real financial risk. You can lose everything you put in.

Dark Null is NOT rug tooling. There are no features for creating fake liquidity, exit-scamming, or wallet-draining. The meme risk oracle is designed to detect rugs, not enable them.

Dark Null is NOT a wash-trading feature. Useful chaff is protocol overhead for privacy properties — it is not a wash-trade mechanism and cannot be used to fake volume.

Dark Null does NOT run a casino. Any use case involving VRF or random outcomes requires a review-grade VRF source. There are no guaranteed-win mechanics anywhere in the system.

Dark Null is NOT sybil-farm infrastructure. Nothing in this system is designed to generate fake wallet activity, fake holder counts, or fake engagement.

Dark Null degen primitives require live evidence gates before real-fund use. Treat design-only primitives as public beta research until deployment evidence, review evidence, and operator controls are complete.

---

*Dark Null Degen Use Cases — NOT_PRODUCTION — devnet design only — no audit — mainnet_ready = false*
