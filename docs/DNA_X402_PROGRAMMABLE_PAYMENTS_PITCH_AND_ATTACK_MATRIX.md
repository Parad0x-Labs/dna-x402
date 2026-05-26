# DNA x402 Programmable Payments Pitch And Attack Matrix

## Position

DNA x402 is a programmable payment rail for agents, humans, APIs, services, compute, auctions, subscriptions, bundles, and proof-based commerce.

The core promise is not one marketplace page. The core promise is:

1. A seller publishes a signed capability manifest.
2. A buyer, human, or agent discovers it through search or quotes.
3. The buyer receives a signed x402 quote.
4. The buyer commits, pays, finalizes, and retries.
5. The seller returns the paid result.
6. The system issues a signed, response-bound receipt.
7. Reputation, proof, reporting, anchoring, and safety controls update around that receipt trail.

## What Can Be Sold

| Category | Capability examples | Payment primitive |
| --- | --- | --- |
| Agent services | research, scraping, automation, support | fixed, metered, bundle |
| GPU / compute | rendering, inference, training jobs | stream, metered, prepaid job |
| Data feeds | prices, signals, API snapshots, alerts | subscription stream, usage metered |
| Physical goods | merch, collectibles, hardware, inventory | fixed price, receipt, fulfillment proof |
| Auctions | English, Dutch, reverse, sealed bid | seller-defined auction state |
| Alpha / copy agents | paid signals, public PnL, success fees | lot ledger, receipts, fee assessment |
| Tool bundles | multi-step agent workflows | bundled upstream receipts |

## Server Listing Model

Human discovery:

- `/agent/marketplace`
- `/agent/programmable-payments`
- `/agent/start`

Agent/API discovery:

- `GET /market/search?capability=gpu_compute`
- `GET /market/quotes?capability=agent_service&maxPrice=5000`
- `GET /market/shops/:shopId`
- `POST /commit`
- `POST /finalize`
- `GET /receipt/:receiptId`

## Programmable Primitives

| Primitive | Status | Proof path |
| --- | --- | --- |
| Fixed price | Green | `programmability.fixtures.test.ts` |
| Usage metered | Green | `programmability.fixtures.test.ts` |
| Surge pricing | Green | `programmability.fixtures.test.ts`, `market.surge.test.ts` |
| Streaming payments | Green | `streaming.test.ts`, `server.stream-replay.test.ts` |
| Netting | Gated | `paymentVerifier.netting.test.ts`, `nettingLedger.test.ts` |
| Auctions | Green | `programmability.fixtures.test.ts`, polyglot proof |
| Bundles | Green | `market.bundleExecutor.test.ts` |
| Marketplace quote discovery | Green | `marketplace.test.ts`, `market.quotes.test.ts` |
| Receipt binding | Green | `server.receipt-response-binding.test.ts` |
| Receipt anchoring | Gated by environment | anchor tests and devnet/mainnet reports |

## Attack Matrix

| Attack / failure | Control |
| --- | --- |
| Quote tampering | Signed quotes and receipt binding |
| Replay / double spend | Transfer and stream replay store |
| Underpay | Verifier rejects below quote total |
| Wrong mint / recipient | Verifier maps mismatch to x402 errors |
| Expired quote | Finalize fails after TTL |
| Response swap | Receipt response digest binds paid payload |
| Commit reuse | Finalized commit is consumed after protected delivery |
| Stream reuse | Stream IDs cannot be reused across commits |
| Unsafe netting | Disabled unless explicitly configured for trusted bilateral mode |
| Malicious listing | Policy denylist, unsafe category block, abuse reports |
| Seller disappears | Reputation and receipt trail; operational dispute flow still needed |
| Physical goods fraud | Requires shipping, dispute, and fulfillment ops before production |
| Spam / quote flood | Rate limits, disabled shops, pause controls |
| Secrets leakage | Secret scan rejects env/key/wallet dump patterns |
| Admin abuse | Admin auth and audit log controls |

## Current Limits

- Physical goods need shipping, fulfillment, and dispute operations before public launch.
- Public restricted categories must stay policy-blocked unless separately compliance-gated.
- Netting is powerful but must stay trusted-bilateral unless live settlement and credit controls are proven.
- Mainnet money movement must remain gated by live proof and operator approval.
