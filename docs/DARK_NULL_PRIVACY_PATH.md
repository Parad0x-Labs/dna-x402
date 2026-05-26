# Dark Null Privacy Path

DNA x402 now exposes a clean optional path for Dark Null private receipts.

The default path remains normal DNA x402:

```txt
quote -> commit -> payment proof -> signed receipt -> paid unlock
```

The optional path adds a Dark Null receipt request after the DNA receipt exists:

```txt
quote -> commit -> payment proof -> signed receipt -> Dark Null private receipt request
```

## Path Selection

| Path | Default | Purpose |
|---|---:|---|
| `normal` | yes | Fast DNA x402 payment, signed receipt, optional receipt anchoring. |
| `dark-null` | no | Additional hash-only private receipt request for privacy-sensitive unlocks. |

Use `resolveDnaX402SettlementPath()` for local policy checks. It accepts only `normal` or `dark-null`.

## SDK Surface

```ts
import {
  createDarkNullPrivacyRequest,
  resolveDnaX402SettlementPath,
  verifyDarkNullPrivacyRequest,
} from "dna-x402";
```

`createDarkNullPrivacyRequest()` consumes a signed DNA receipt and produces a Dark Null request object that stores hashes for resource, recipient, mint, receipt signature, request digest, and response digest.

It requires:

- signed DNA receipt
- canonical transfer `txSignature`
- Solana settlement slot
- Dark Null target cluster, program id, and manifest label

It does not store:

- raw resource URL
- raw recipient
- raw mint
- raw payment header
- raw buyer metadata

## Devnet And Mainnet

DNA x402 normal path:

- mainnet-beta receipt-anchor program is active for DNA receipt anchoring
- Public Beta live payment flows are capped and direct-split gated

Dark Null path:

- devnet is the first evidence lane
- `canonical-devnet-root-2` is the current Dark Null manifest target
- mainnet-beta requires promoted Dark Null deployment evidence before hosted enablement

## Test Gate

```bash
npm --prefix x402 run typecheck:x402
npm --prefix x402 exec vitest run tests/dark-null.privacy.test.ts
```

The test proves:

- normal path stays default
- Dark Null request strips raw resource metadata
- missing settlement evidence fails
- tampering changes the request hash

## Product Fit

Use the optional path for:

- paid alpha reveals
- private signal rooms
- wallet-stalker reports
- API access receipts
- receipt chains where raw resource paths should stay out of public logs

Use the normal path for ordinary paid APIs, inference calls, data feeds, and builder apps that only need DNA receipts.
