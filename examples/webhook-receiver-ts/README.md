# Webhook Receiver Example

Private-pilot webhook receiver with HMAC verification.

## Install

```bash
npm install
```

## Run

```bash
npm run dev
```

## Test

```bash
npm test
```

## Expected Output

```txt
webhook-receiver: listening on http://127.0.0.1:3201
webhook-receiver: POST /webhooks/dna
```

Do not use this as a public webhook ingress until replay storage, monitoring, and auth are configured.
