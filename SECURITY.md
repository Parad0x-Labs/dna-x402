# Security Policy

## Reporting a Vulnerability

If you discover a vulnerability, do not open a public issue with exploit details.

Send a private report with:
- affected component/path
- reproduction steps
- impact analysis
- suggested fix (if available)

Until a private channel is configured, open a minimal issue titled `SECURITY: private report requested` without sensitive details.

## Secret Handling Rules

- Never commit `.env`, `.env.local`, or private key material.
- Never post deployer keypairs, receipt signing secrets, or wallet seed material.
- Use `x402/.env.example` for non-secret configuration templates.

## Threat Model Summary (v0)

Main risks covered:
- replay/double-finalize attempts
- forged payment proofs
- stale quote reuse
- forged receipt signatures
- inflated analytics from unverified events

Main controls:
- strict proof verification (mint/recipient/amount/recency)
- receipt signature and hash-chain verification
- pause flags (`PAUSE_MARKET`, `PAUSE_FINALIZE`, `PAUSE_ORDERS`)
- rate limiting on market write surfaces
- verified tier requires on-chain anchor confirmation

## Security Checks

Run before sharing/deploying:

```bash
cd x402
npm run security:scan
npm test
npm run audit:full -- --cluster devnet --deployer-keypair <KEYPAIR> --upgrade-authority <PUBKEY>
```
