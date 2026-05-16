# Webhooks

Status: Public Beta.

Webhook delivery uses signed JSON payloads and replay protection.

## Headers

- `x-dna-signature`
- `x-dna-event`
- `x-dna-timestamp`
- `x-dna-idempotency-key`

## Signature

The signature is HMAC-SHA256 over the raw JSON body.

## Replay Rule

Every idempotency key must be accepted once and rejected on replay. In Postgres mode, replay keys survive restart.

## Sandbox Receiver

`POST /v1/webhooks/receiver-test` is sandbox-only. It must not be exposed as a public production webhook ingress.

## Example

```bash
cd examples/webhook-receiver-ts
npm install
npm run dev
npm test
```
