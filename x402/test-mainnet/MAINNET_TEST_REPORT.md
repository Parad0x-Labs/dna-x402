# DNA x402 - Mainnet Integration Test Report

Status: INVALIDATED

This tracked report is intentionally not a release proof. The previous report was removed because it contained non-confirmable anchor transaction placeholders and stale burner-key disclosure text.

Fresh mainnet proof must be generated from ignored runtime artifacts only:

1. Generate or reuse G-local keys with `npm run proof:bootstrap-keys -- --cluster mainnet`.
2. Fund the printed mainnet deployer public key with at least `0.25 SOL` and `6 USDC`.
3. Start the server with the ignored `x402/test-mainnet/keys/mainnet/runtime.env` values.
4. Run `npm run proof:mainnet:smoke` or `npm run proof:mainnet:mayhem`.

Acceptance rules:

- No `null`, `undefined`, or placeholder Solana transaction signatures.
- Every emitted Solscan transaction link must contain a real confirmed mainnet signature.
- If anchoring is enabled, anchored receipt count must be non-zero and every tested receipt must have a confirmed anchor signature.
- No private key material belongs in tracked reports.
