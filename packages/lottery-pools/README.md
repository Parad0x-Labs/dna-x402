# @parad0x_labs/lottery-pools

TypeScript client math for the `null_lottery_pools` Solana program
([`programs/null_lottery_pools`](../../programs/null_lottery_pools)). No runtime dependencies
(`node:crypto` SHA-256); Node.js 22.6 or later runs the TypeScript source directly.

- Ticket leaf, round Merkle root, proofs and the on-chain incremental append (`ticketLeaf`, `rootOf`,
  `proofOf`, `rootFromProof`, `IncrementalTree`).
- Creator fee curve and ticket split (`recoupVolume`, `feeRate`, `creatorFee`, `splitTicket`,
  `jackpotCap`, `applyCap`).
- Draw slot selection, entropy and numbers (`selectSlotHash`, `drawEntropy`, `drawNumbers`).
- Instruction data encoders, PDA seeds, pool and round account decoders, BuyTicket log parser,
  error names.

Program ids are not hardcoded: derive addresses from `poolSeeds`, `roundSeeds` and `claimSeeds` with
the program id from your configuration.

```bash
npm install --ignore-scripts
npm run lint
npm test   # recomputes programs/null_lottery_pools/tests/vectors/lottery_pools_v1.json
```
