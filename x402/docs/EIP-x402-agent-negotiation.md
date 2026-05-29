# EIP-x402-001: Agent Price Negotiation Extension

**Title:** Agent Price Negotiation for the x402 HTTP Payment Protocol  
**Authors:** Parad0x Labs  
**Status:** Draft  
**Category:** Application Extension  
**Created:** 2026-05-29  
**Repository:** https://github.com/Parad0x-Labs/dna-x402

---

## Abstract

This proposal extends the x402 HTTP payment protocol with a lightweight
price-negotiation handshake.  Autonomous AI agents can bid below the listed
price; servers respond with a counter-offer or issue a full quote at the
agreed price.  The negotiation completes in at most `maxRounds` HTTP
round-trips before the server commits to a take-it-or-leave-it floor price.
No new cryptographic material, off-chain coordination, or signed bids are
required.

---

## Motivation

The x402 protocol (Coinbase / Cloudflare, 2025) defines how a server issues a
`402 Payment Required` response and how a client pays.  The listed price is
fixed — there is no mechanism for an agent to signal that it considers the
price too high, or to discover the lowest price the server will accept.

AI agents act as autonomous economic actors with per-task budgets.  Without
negotiation, agents must either:

1. Pay the full listed price regardless of their budget, wasting funds.
2. Fail the request and stop, even when the server would have accepted less.

Centralised ad-auction analogies (Google Ads second-price auctions, programmatic
media buying) show that price discovery between automated buyers and sellers
dramatically improves both utilisation and revenue.  We bring that pattern to
agent-to-server micropayments.

---

## Specification

### New HTTP Request Headers

| Header | Type | Description |
|---|---|---|
| `x-dnp-offer` | string (integer, atomic units) | Agent's bid for this request |
| `x-dnp-negotiate-round` | string (positive integer) | Current negotiation round (default 1) |

Headers are sent by the **client** on a probing request before the full payment flow.

### Server-Side Behaviour

Servers that support negotiation include a `NegotiationPolicy` in their
`PaywallOptions`:

```typescript
interface NegotiationPolicy {
  enabled: boolean;
  floorPriceAtomic: string;   // minimum price the server will accept
  maxRounds?: number;         // default 2; after this many rounds server accepts at floor
}
```

When a request arrives:

#### Case 1 — No offer header

Server responds with the standard `402` body and additionally includes a
`negotiation` advertisement block:

```json
{
  "error": "payment_required",
  "negotiation": {
    "enabled": true,
    "floorPriceAtomic": "3000",
    "listedPriceAtomic": "5000",
    "maxRounds": 2
  },
  "paymentRequirements": { ... }
}
```

The `paymentRequirements` block is still present at the **listed price**, so
non-negotiation-aware clients can pay normally.

#### Case 2 — Offer ≥ floor

Server accepts.  Responds `402` with a full quote at `min(offer, listedPrice)`.
The `negotiation` block is **absent** — the client proceeds directly to payment.

```json
{
  "error": "payment_required",
  "paymentRequirements": {
    "quote": { "totalAtomic": "4000", ... },
    ...
  }
}
```

#### Case 3 — Offer < floor AND round < maxRounds

Server counters.  Responds `402` with **only** a `negotiation` block; no
`paymentRequirements`.  Client must not attempt payment.

```json
{
  "error": "payment_required",
  "negotiation": {
    "enabled": true,
    "floorPriceAtomic": "3000",
    "listedPriceAtomic": "5000",
    "counterPriceAtomic": "3000",
    "round": 2,
    "maxRounds": 2
  }
}
```

#### Case 4 — Offer < floor AND round ≥ maxRounds (final round)

Server accepts at floor unconditionally.  Same as Case 2 but `totalAtomic` =
`floorPriceAtomic`.  This ensures negotiation always terminates.

### Server Algorithm (pseudo-code)

```
function evaluateOffer(offer, listed, policy, round):
  offer = clamp(offer, 0, listed)          # agents cannot overpay
  if offer >= policy.floor:
    return { accepted: true, agreedPrice: offer }
  if round >= policy.maxRounds:
    return { accepted: true, agreedPrice: policy.floor }  # final-round fallback
  return { accepted: false, counter: policy.floor, nextRound: round + 1 }
```

### Client-Side Behaviour

Clients implement an autonomous bid loop before entering the normal payment flow:

```
targetPrice = negotiation.targetPriceAtomic   # user's desired bid
maxPrice    = negotiation.maxPriceAtomic       # hard cap; agent never pays more
round       = 1
currentOffer = targetPrice

while round <= maxRounds:
  response = GET url with headers { x-dnp-offer: currentOffer, x-dnp-negotiate-round: round }

  if response.status != 402:
    return response   # resource is free now

  if response.body.negotiation is absent:
    fallthrough to fetchWith402(url, maxPrice)   # server not negotiation-aware

  if response.body.paymentRequirements exists:
    # Server accepted — proceed to pay at agreedPrice
    return fetchWith402(url, { offer: agreedPrice, maxPrice })

  # Server countered
  counter = response.body.negotiation.counterPriceAtomic
  if BigInt(counter) > BigInt(maxPrice):
    raise Error("counter exceeds agent max budget")
  currentOffer = counter
  round = response.body.negotiation.round

# Rounds exhausted — pay at last offer (always <= maxPrice)
return fetchWith402(url, { offer: currentOffer, maxPrice })
```

### Invariants

1. **Termination** — at most `maxRounds` probe requests before payment or abort.
2. **No overpay** — server caps `agreedPrice` at `listedPrice`.
3. **No underpay** — server never accepts below `floorPriceAtomic`.
4. **Client budget** — client throws if any counter exceeds `maxPriceAtomic`.
5. **Backward compatibility** — servers without `negotiation.enabled` ignore
   the new headers; clients treat them as non-negotiation-aware and pay listed.

---

## Reference Implementation

### Server

```typescript
import { dnaPaywall } from "dna-x402";

app.use("/api/inference", dnaPaywall({
  priceAtomic: "5000",
  recipient: "YOUR_WALLET",
  negotiation: {
    enabled: true,
    floorPriceAtomic: "3000",
    maxRounds: 2,
  },
}));
```

### Client

```typescript
import { fetchWithNegotiation } from "dna-x402";

const result = await fetchWithNegotiation("https://provider.example/api/inference", {
  wallet: myAgentWallet,
  maxSpendAtomic: "10000",
  negotiation: {
    targetPriceAtomic: "3000",   // start bidding here
    maxPriceAtomic: "5000",      // never pay more than this
  },
});
```

Both sides are in `dna-x402` as of v1.1.0.

---

## Security Considerations

### Replay of Accepted Offers

An offer header with `x-dnp-negotiate-round` does not carry a signature.
A server must NOT honour a previously-probed offer for a different request —
quotes are scoped to `(quoteId, method, resource, priceAtomic, expiresAt)`.
The `memoHash` in the quote captures all of these; replaying an old offer
issues a fresh quote with a new `quoteId` and expiry.

### Integer Overflow

Implementations must validate that offer strings parse to non-negative integers
within the platform's safe integer range.  The reference implementation treats
invalid strings as 0, triggering a counter (never an accept).

### DoS via Round Exhaustion

A malicious client could probe with round=1, round=2, ... up to maxRounds
on every request.  Each probe is a cheap 402 rejection with no payment.
Servers should rate-limit the `/` path by IP or agent key if abuse is a concern.
Probe responses contain no `paymentRequirements` in the counter case, so no
expensive state (quote records) is created.

### Price Oracle Manipulation

Floor and ceiling prices are set by the server operator in `NegotiationPolicy`.
Agents cannot force the server below `floorPriceAtomic` regardless of how many
rounds they run.

---

## Comparison with Existing Standards

| Mechanism | Round-trips | Signed bids | Off-chain coord | Works in HTTP |
|---|---|---|---|---|
| x402 (base) | 1 probe + 1 pay | No | No | Yes |
| **This proposal** | 1-3 probes + 1 pay | No | No | Yes |
| FIPA Contract Net | N (broadcast) | Yes | Required | No |
| Dutch auction | Timed | No | Required | No |
| OpenAI usage tiers | 0 (fixed) | N/A | N/A | N/A |

This proposal sits in the sweet spot: no new infrastructure, no signed bids,
no trusted third party — just HTTP headers and deterministic server-side rules.

---

## Prior Art

- x402 base protocol: https://github.com/x402-foundation/x402
- Cloudflare AI Gateway pay-per-request: static pricing only
- Pay.sh: static pricing only
- Solana Foundation x402 integration: static pricing only

None of the above implement bidding or negotiation.  This proposal is the first
to define a standardised negotiation extension for x402.

---

## Copyright

Copyright 2026 Parad0x Labs. Licensed MIT.

Portions of this specification describe behaviour already implemented and
timestamped in the dna-x402 repository (commit 9b672794, 2026-05-28).
