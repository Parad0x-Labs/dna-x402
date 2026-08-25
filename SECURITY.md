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

## Hardening Record (August 2026)

Verified live on Agave 4.2.1 devnet; hostile instructions rejected with expected program errors. Evidence: [`devnet-tests/RESULTS.md`](./devnet-tests/RESULTS.md).

- `openclaw-x402-gate`: ed25519 payment signature verification, single-use replay store, on-chain settlement confirmed by default, payee validated in the confirmed transaction.
- `agent_credential_mint`: revocation and device-key rotation require program signatures from the protocol authority / agent wallet.
- `null_token_hook`: canonical `[b"hook-config"]` PDA binds allowlist administration to one config; execution is fail-closed under the `mainnet` feature.
- `dark_nullifier_banks`: initialization of live bank state is rejected (`BankAlreadyInitialized`).
- `null_mint_gate`: emission claims are co-signed by the stored config authority.
- `dark_shielded_pool`, `receipt_commitment_tree`: PDA creation tolerates lamport front-running via top-up/allocate/assign.
- x402 server layer: callback URL validation (loopback/link-local/private-range), synchronous proof reservation in seller/paywall finalize paths, constant-time API key comparison.

## Security Checks

Run before sharing/deploying:

```bash
cd x402
npm run security:scan
npm test
npm run audit:full -- --cluster devnet --deployer-keypair <KEYPAIR> --upgrade-authority <PUBKEY>
```
