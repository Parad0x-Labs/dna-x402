# @parad0x_labs/fair-draw

Client SDK for the `null_fair_draw` Solana program ([`programs/null_fair_draw`](../../programs/null_fair_draw)):
provably fair raffles, giveaways and reward roll-outs. No runtime dependencies; Node.js 22.6 or later runs the
TypeScript source directly. `src/core.ts` has no imports and also runs in the browser.

| Function | What it does |
|---|---|
| `createDraw` | CreateDraw (plus the Extend instructions a large draw needs) and the draw / vault addresses |
| `fundPrizes` | FundPrizes: escrows every prize (SOL, or SPL with the funder's token account) |
| `enter` | Enter an open raffle (`count` entries, optional owner other than the payer) |
| `commitList` | Builds the sum tree from CSV or JSON (`wallet,weight` / `[{ wallet, weight }]`) and the CommitList instruction |
| `crank` | The next permissionless step: Draw, Resolve (batch, or one weighted slot with its proof) or Advance |
| `claim` | The Claim instruction for a winner's slot, with its leaf proof when the slot needs one |
| `verify` | Recomputes the draw from public data and checks every winner and proof against the chain |
| `exportProofs` / `exportList` | Every entry's proof and the list as JSON, for publishing next to the commitment |

Builders return plain instructions `{ programId, keys, data }`; `toWeb3Instruction(ix, web3)` converts one with
the `@solana/web3.js` module you pass in. Reads go through `jsonRpc(url)` or any object with
`getAccountData` and `getLogs`. Program ids are not hardcoded: pass yours (devnet:
`FZxUXmGNzivQCw1nS6N6GakwyWN1PrX5ebGnS7hPjzGL`).

```ts
import * as web3 from "@solana/web3.js";
import { createDraw, fundPrizes, commitList, crank, claim, verify, jsonRpc, toWeb3Instruction, MODE_LIST } from "@parad0x_labs/fair-draw";

const programId = "FZxUXmGNzivQCw1nS6N6GakwyWN1PrX5ebGnS7hPjzGL";
const { draw, instructions } = createDraw({
  programId, organizer, drawId: 1n,
  params: { mode: MODE_LIST, weighted: true, redrawRounds: 2, entryPrice: 0n, walletCap: 0n, closeSlot: 0n,
            claimWindowSlots: 216_000n, tiers: [{ count: 1, amount: 1_000_000_000n }, { count: 5, amount: 100_000_000n }] },
});
const fund = fundPrizes({ programId, funder: organizer, draw });
const { instruction: commit, list } = commitList({ programId, organizer, draw, list: csvText, weighted: true });
// send instructions, fund and commit (in that order) with your wallet, publish the list, then:
const rpc = jsonRpc("https://api.devnet.solana.com");
const step = await crank(rpc, { programId, draw, entries: list.entries });  // Draw, Resolve..., Advance
const report = await verify(rpc, { programId, draw, entries: list.entries });
console.log(report.ok, report.winners);
```

## Verify page

[`verify.html`](./verify.html) is a self-contained page that verifies any draw on devnet (or another RPC): it
loads `@solana/web3.js` 1.98.0 from jsDelivr with Subresource Integrity
(`sha256-icPWwnyuk4gteBU+9/I8jVD1P14/C3Jma7kJxqTcn6w=`, the hash jsDelivr's data API lists for
`lib/index.iife.min.js`; the browser refuses the script if the bytes differ) and runs the same `core.ts` code
the SDK tests, inlined with its types stripped by `npm run build:verify`. The SDK test fails if the page and
`core.ts` drift apart.

## Tests

```bash
npm install --ignore-scripts
npm run lint
npm test   # recomputes programs/null_fair_draw/tests/vectors/fair_draw_v1.json and runs the SDK flows offline
```
