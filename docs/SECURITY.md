# Security

## Vulnerability Reporting

Do not open public issues with exploit details.

Submit a private report containing:
- affected component/path
- reproduction steps
- impact
- suggested fix (optional)

If no private channel is configured yet, open a minimal issue titled `SECURITY: private report requested` without sensitive detail.

## Secret Handling

- Never commit `.env` or key material.
- Never commit receipt signing secrets, wallet seed phrases, or deployer keypairs.
- Use `x402/.env.example` for template configuration only.

## Threat Model (v0)

Covered controls:
- replay detection for payment proofs
- strict proof verification for mint/recipient/amount
- receipt signature validation and request/response digest binding
- pause flags for market/finalize/orders
- analytics verified tier gated by confirmed anchors

## Required Security Checks

```bash
cd x402
npm run security:scan
npm test
npm run audit:prod
```
