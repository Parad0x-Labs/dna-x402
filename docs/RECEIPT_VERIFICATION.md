# Receipt Verification

Status: Public Beta verification guide.

Receipts bind quote, commit, payment proof, request digest, response digest, policy metadata, and fee waterfall hash.

## Verify With SDK

```ts
import { verifySignedReceipt } from "dna-x402";

const ok = verifySignedReceipt(receipt);
if (!ok) throw new Error("invalid receipt");
```

## Verify Fee Waterfall

Receipts can include:

- `feeWaterfallHash`
- `feeLines`
- `feeCollectionSummary`

The receipt is valid only if the fee waterfall hash matches the quoted waterfall.

## Example

```bash
cd examples/receipt-verifier-ts
npm install
npm run dev
npm test
```
