# X402 Compatibility

This server accepts common x402 header dialects and normalizes them into one canonical internal schema.

## Supported Headers

| Purpose | Header Names | Encoding |
| --- | --- | --- |
| Payment requirements | `PAYMENT-REQUIRED`, `X-PAYMENT-REQUIRED`, `X-402-PAYMENT-REQUIRED` | JSON or base64(JSON) |
| Payment proof | `PAYMENT-SIGNATURE`, `X-PAYMENT`, `X-402-PAYMENT` | JSON or base64(JSON) |

## Canonical Requirement Schema

```json
{
  "version": "x402-v1",
  "network": "solana",
  "currency": "USDC",
  "amountAtomic": "1000",
  "recipient": "<address>",
  "memo": "<optional>",
  "expiresAt": 1893456000000,
  "settlement": {
    "mode": "spl_transfer",
    "mint": "<mint>",
    "chainId": null
  }
}
```

## Canonical Proof Schema

```json
{
  "version": "x402-proof-v1",
  "scheme": "solana_spl",
  "txSig": "<signature>",
  "proofBlob": null,
  "sender": "<optional>"
}
```

## Request Flow

1. Request resource.
2. Server returns HTTP 402 and includes payment requirements in response body and compatibility headers.
3. Client pays and retries with one supported proof header.
4. Server verifies proof, issues receipt, and returns 200.

## Compatibility Doctor

Use doctor to inspect formatting and missing fields before integration debugging.

- `GET /x402/doctor`
- `POST /x402/doctor`

Example:

```bash
curl -X POST http://localhost:8080/x402/doctor \
  -H 'content-type: application/json' \
  -d '{"headers":{"PAYMENT-REQUIRED":"<base64>","PAYMENT-SIGNATURE":"<base64>"}}'
```

## Dialect Examples

### Coinbase-style

```bash
curl -i http://localhost:8080/resource

curl -i http://localhost:8080/resource \
  -H "PAYMENT-REQUIRED: <base64 requirements>" \
  -H "PAYMENT-SIGNATURE: <base64 proof>"
```

### Memeputer-style

```bash
curl -i http://localhost:8080/resource \
  -H "X-PAYMENT-REQUIRED: <base64 requirements>" \
  -H "X-PAYMENT: <base64 proof>"
```

## Error Contract

All x402 errors return:

```json
{
  "error": {
    "code": "X402_MISSING_PAYMENT_PROOF",
    "message": "Missing payment proof header.",
    "cause": "Request did not include X-PAYMENT or PAYMENT-SIGNATURE.",
    "hint": ["..."],
    "dialectDetected": "coinbase",
    "missing": ["PAYMENT-SIGNATURE|X-PAYMENT|X-402-PAYMENT"],
    "receivedHeaders": ["accept", "payment-required"],
    "redacted": {
      "paymentRequired": "eyJ2ZXJz...MDAwfQ== (len=312)",
      "paymentProof": null
    },
    "exampleFix": {
      "curl": "curl -H 'PAYMENT-SIGNATURE: <proof>' -H 'PAYMENT-REQUIRED: <requirements>' https://your-host/resource"
    },
    "traceId": "<uuid>",
    "docsUrl": "/docs/x402-compat#error-x402-missing-payment-proof"
  }
}
```

## Stable Errors

### Parsing and dialect

#### `X402_PARSE_FAILED`
Meaning: parser could not read requirements or proof payload.
Likely cause: malformed JSON or malformed base64 payload.
Fix:
- send JSON or base64(JSON)
- run `/x402/doctor` to inspect parse warnings

```bash
curl -X POST http://localhost:8080/x402/doctor -H 'content-type: application/json' -d '{"headers":{"PAYMENT-REQUIRED":"<bad>"}}'
```

Anchor: <a id="error-x402-parse-failed"></a>

#### `X402_UNSUPPORTED_DIALECT`
Meaning: no supported x402 header names were found.
Likely cause: custom header names not in compatibility table.
Fix:
- use a supported required header
- use a supported proof header

```bash
curl -H "PAYMENT-REQUIRED: <base64>" -H "PAYMENT-SIGNATURE: <base64>" https://your-host/resource
```

Anchor: <a id="error-x402-unsupported-dialect"></a>

#### `X402_MISSING_PAYMENT_REQUIRED`
Meaning: proof was attempted without requirements context.
Likely cause: second request omitted required header.
Fix:
- re-run initial request
- include the returned requirements header on retry

Anchor: <a id="error-x402-missing-payment-required"></a>

#### `X402_MISSING_PAYMENT_PROOF`
Meaning: requirements present but proof missing.
Likely cause: retry request omitted proof header.
Fix:
- include `PAYMENT-SIGNATURE` or `X-PAYMENT`
- include requirements header from first 402

Anchor: <a id="error-x402-missing-payment-proof"></a>

### Requirement validation

#### `X402_REQUIRED_INVALID`
Meaning: required fields could not be parsed.
Likely cause: amount/recipient/currency missing or invalid.
Fix:
- set `amountAtomic`, `recipient`, `currency`
- confirm recipient format and atomic unit format

Anchor: <a id="error-x402-required-invalid"></a>

#### `X402_EXPIRED_REQUIREMENTS`
Meaning: requirements are expired.
Likely cause: stale requirements reused.
Fix:
- request fresh 402 requirements
- retry payment with new values

Anchor: <a id="error-x402-expired-requirements"></a>

#### `X402_UNSUPPORTED_NETWORK`
Meaning: network unsupported in this deployment.
Likely cause: requirements indicate non-supported network.
Fix:
- use server-supported network
- verify cluster configuration

Anchor: <a id="error-x402-unsupported-network"></a>

#### `X402_UNSUPPORTED_CURRENCY`
Meaning: unsupported currency or mint.
Likely cause: currency changed between requirement and payment.
Fix:
- use required currency and mint exactly

Anchor: <a id="error-x402-unsupported-currency"></a>

#### `X402_INVALID_AMOUNT`
Meaning: invalid amount value.
Likely cause: non-integer or non-positive amount.
Fix:
- send integer atomic amount > 0

Anchor: <a id="error-x402-invalid-amount"></a>

#### `X402_INVALID_RECIPIENT`
Meaning: recipient invalid or missing.
Likely cause: malformed address.
Fix:
- send recipient exactly from requirements

Anchor: <a id="error-x402-invalid-recipient"></a>

### Proof and verification

#### `X402_PROOF_INVALID`
Meaning: proof format unsupported.
Likely cause: proof missing tx signature fields.
Fix:
- include `txSig`/`txSignature` in proof JSON

Anchor: <a id="error-x402-proof-invalid"></a>

#### `X402_REQUIRED_PROOF_MISMATCH`
Meaning: proof does not match requirement fields.
Likely cause: reused proof from different quote or recipient.
Fix:
- generate new proof for current requirements

Anchor: <a id="error-x402-required-proof-mismatch"></a>

#### `X402_UNDERPAY`
Meaning: on-chain amount below required amount.
Likely cause: partial payment.
Fix:
- pay full amount and retry

Anchor: <a id="error-x402-underpay"></a>

#### `X402_WRONG_MINT`
Meaning: payment used wrong mint.
Likely cause: token mismatch.
Fix:
- use required mint

Anchor: <a id="error-x402-wrong-mint"></a>

#### `X402_WRONG_RECIPIENT`
Meaning: payment sent to wrong recipient.
Likely cause: destination mismatch.
Fix:
- pay exact recipient from requirements

Anchor: <a id="error-x402-wrong-recipient"></a>

#### `X402_REPLAY_DETECTED`
Meaning: proof already consumed.
Likely cause: replayed tx signature.
Fix:
- generate a new payment proof

Anchor: <a id="error-x402-replay-detected"></a>

#### `X402_VERIFICATION_FAILED`
Meaning: verification failed for supplied proof.
Likely cause: cluster mismatch or invalid proof details.
Fix:
- verify transaction finalized on target cluster
- verify amount/mint/recipient values

Anchor: <a id="error-x402-verification-failed"></a>

### Server state

#### `X402_PAUSED`
Meaning: operator paused route.
Likely cause: safety switch active.
Fix:
- retry later
- inspect `/health` pause flags

Anchor: <a id="error-x402-paused"></a>

#### `X402_RATE_LIMITED`
Meaning: request rate exceeded configured limits.
Likely cause: aggressive retry loop.
Fix:
- back off and respect retry cadence

Anchor: <a id="error-x402-rate-limited"></a>

#### `X402_INTERNAL`
Meaning: unexpected internal error.
Likely cause: server exception.
Fix:
- retry with `traceId`
- contact operator with traceId and timestamp

Anchor: <a id="error-x402-internal"></a>
