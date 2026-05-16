# DNA x402 Error Codes

Status: Public Beta error reference.

## Payment

| Code | Meaning |
| --- | --- |
| `X402_UNDERPAY` | Payment proof amount is below quoted amount. |
| `X402_WRONG_RECIPIENT` | Payment proof recipient does not match quote. |
| `X402_WRONG_MINT` | Payment proof token/mint does not match quote. |
| `X402_REPLAY_DETECTED` | Payment proof has already been used. |
| `X402_PROOF_FOR_DIFFERENT_QUOTE` | Payment proof belongs to another quote or commit. |
| `X402_QUOTE_EXPIRED` | Quote expired before commit/finalize. |
| `X402_UNSUPPORTED_SETTLEMENT` | Settlement mode is not allowed for the quote. |

## Policy

| Code | Meaning |
| --- | --- |
| `POLICY_BLOCK` | Policy blocked the action. |
| `REVIEW_REQUIRED` | Policy routed the action to review. |
| `SELLER_SUSPENDED` | Seller cannot publish or quote. |
| `LISTING_DISABLED` | Listing cannot be quoted. |

## Builder Fees

| Code | Meaning |
| --- | --- |
| `BUILDER_FEE_RECIPIENT_MISSING` | Builder fee has no treasury recipient. |
| `BUILDER_FEE_EXCEEDS_CAP` | Builder fee exceeds configured cap. |
| `BUILDER_SUSPENDED` | Builder cannot charge fees. |
| `BUILDER_DISABLED` | Builder cannot charge fees. |
| `BUILDER_FEE_HIDDEN` | Builder fee is not visible to buyer. |
| `BUILDER_FEE_DIRECT_SPLIT_GATED` | Direct split is not approved. |
| `BUILDER_FEE_DNA_OVERRIDE_ATTEMPT` | Builder attempted to replace DNA fee. |
| `FEE_WATERFALL_TAMPERED` | Fee waterfall hash or line set changed. |

## Webhooks

| Code | Meaning |
| --- | --- |
| `WEBHOOK_BAD_SIGNATURE` | Signature verification failed. |
| `WEBHOOK_OLD_TIMESTAMP` | Timestamp outside replay window. |
| `WEBHOOK_REPLAY_REJECTED` | Idempotency key already used. |
| `WEBHOOK_IMMUTABLE_LOG_PII_BLOCKED` | PII guard blocked immutable webhook log. |
