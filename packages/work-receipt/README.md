# @parad0x_labs/work-receipt

**Verify agent work, not just payment.** Trustless, serverless, non-custodial task↔deliverable
binding plus a deterministic check gate, anchored on Solana. Composes with
[`@parad0x_labs/receipt-dag`](https://github.com/Parad0x-Labs/dna-x402/tree/main/packages/receipt-dag).

Identity, payment, and anchored receipts don't prove a deliverable was bound to the task that was
asked — or that it's correct. This is that missing middle, with no server, no escrow, and no new
trusted party.

## Flow

1. **`pinTask`** — the requester signs `taskSpecHash` **before** work starts (this is load-bearing:
   it stops a worker from retro-fitting a spec to whatever it produced).
2. **`signWorkBinding`** — the worker welds `{taskSpecHash, deliverableDigest, requester_pub,
   worker_pub, nonce, expiry}` into one signature, and **refuses** without a valid prior pin.
   Deliver Y and call it X → the digest changes → the signature is a forgery, not a relabel.
3. **`signAccept`** — the *pinning* requester signs an accept/reject verdict over the **verified**
   binding (a `reject` is the anchored dispute *signal*). Authority is enforced, never opt-in.
4. **`checkGate`** — for the deterministic subset (output-hash match, JSON-schema), anyone can
   re-run the predicate; it's bound to the pinned hash, so a worker can't supply its own grader.
   Everything else returns **`undecided`** — never a silent accept.
5. **`bindToDag`** — anchor a canonical `actionHash` through receipt-dag to a live mainnet program.

```js
import { pinTask, signWorkBinding, verifyWorkBinding, signAccept, verifyAccept, checkGate } from "@parad0x_labs/work-receipt";

const { pin, sigT } = pinTask({ taskSpec, requesterSeed32, nonce, expiry });          // requester, before work
const { binding, sigW } = signWorkBinding({ pin, sigT, deliverable, workerSeed32, nonce, expiry });  // worker
verifyWorkBinding({ binding, sigW, pin, sigT, deliverable });                          // anyone: { valid: true }
const { verdict, sigA } = signAccept({ pin, sigT, binding, sigW, verdict: "accept", requesterSeed32, nonce });
verifyAccept({ verdict, sigA, pin, sigT, binding, sigW });                             // { valid: true }
```

## What it does NOT do (by design — stated plainly)

- **No fair exchange.** A requester can see-then-withhold the accept; a worker can withhold bytes.
  The absence of an accept is a dispute *signal*, not a clawback — fair exchange is impossible
  non-custodially with signatures alone (Pagnia–Gärtner).
- **No subjective correctness.** There is no agent-as-judge; non-deterministic work returns `undecided`.
- **No dispute resolver.** It *records* conflicting attestations on-chain; it does not adjudicate.
- **No sybil resistance.** A single party can rubber-stamp its own keys.

MIT.
