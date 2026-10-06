# @parad0x_labs/lottery-pools

TypeScript client math for the `null_lottery_pools` Solana program
([`programs/null_lottery_pools`](../../programs/null_lottery_pools)). No runtime dependencies
(`node:crypto` SHA-256); Node.js 22.6 or later runs the TypeScript source directly.

- Ticket leaf, round Merkle root, proofs and the on-chain incremental append (`ticketLeaf`, `rootOf`,
  `proofOf`, `rootFromProof`, `IncrementalTree`).
- Creator fee curve and ticket split, with the optional second tier (`recoupVolume`, `feeRate`,
  `creatorFee`, `splitTicket`, `jackpotCap`, `applyCap`, `prizeTier`, `validParams`).
- Presets and a pre-launch summary: `SMALL_POOL_PRESET` (0.5 SOL seed, 3 of 18, 10% tier 2),
  `SMALL_POOL_JACKPOT_ONLY`, `LARGE_POOL_PRESET`, and `poolSummary(config)`, which returns what a UI shows before
  anyone seeds or buys: break-even sales, creator fees and net at given sales (default 2 and 5 SOL), the jackpot
  at those sales, per-ticket jackpot, tier-2 and any-prize chances, the long-run tier-2 EV and average tier-2
  prize, and the chance that someone wins something in rounds of 20, 50 and 100 tickets, with the assumptions
  spelled out.
- Draw slot selection, entropy and numbers (`selectSlotHash`, `drawEntropy`, `drawNumbers`).
- Instruction data encoders (CreatePool keeps the original encoding when tier 2 is off), PDA seeds, pool
  and round (layout v2) decoders, BuyTicket log parser, error names.

```ts
import { poolSummary, SMALL_POOL_PRESET } from "@parad0x_labs/lottery-pools";
const s = poolSummary(SMALL_POOL_PRESET);
// s.seeder.recoupTickets = 167n; s.seeder.atSales[1] = { sales: 5 SOL, creatorFees: 1_050_150_000n, net: 550_150_000n, ... }
// s.buyer.pTier2 = 45/816; s.buyer.typicalTier2Prize = 18_133_333n; s.buyer.jackpotAt[1].jackpot = 3_699_850_000n
```

Program ids are not hardcoded: derive addresses from `poolSeeds`, `roundSeeds` and `claimSeeds` with
the program id from your configuration.

```bash
npm install --ignore-scripts
npm run lint
npm test   # recomputes programs/null_lottery_pools/tests/vectors/lottery_pools_v1.json
```
