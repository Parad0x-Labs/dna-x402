# Face ID (P-256) Sign-In — Real On-Chain Verification

Reproduce (devnet): `npm run passport:devnet:faceid -- <PROGRAM_ID>`

## What this proves

The `dark_secp256r1_vault` program, built `--features mainnet`, performs **real
on-chain P-256 verification** via the Agave secp256r1 precompile (SIMD-0075).
Proven end-to-end on devnet:

| Step | Result |
|------|--------|
| Register — bind a P-256 key (precompile-verified pubkey) | PASS (real tx) |
| Sign-in — bound key signs the live challenge, challenge rotates | PASS (real tx) |
| Negative — wrong message signed | REJECTED `0x400b ChallengeNotSigned` |
| Negative — different P-256 key signs | REJECTED `0x4009 PasskeyPubkeyMismatch` |

The two negative tests are the point: a valid signature over the *wrong* message,
and a valid signature from the *wrong* key, are both rejected on-chain. The
verification is real, not a presence check.

`evidence/passport/devnet-faceid-e2e.json` carries the live devnet tx signatures
and Explorer links.

## Implementation notes (for reproducers)

- The precompile verifies ECDSA-P256 with **SHA-256** over the raw message and
  **requires low-S** (`s <= n/2`). noble emits valid but sometimes high-S sigs;
  the harness normalizes `s -> n-s`. This was the one non-obvious interop detail
  (see `scripts/passport/probe-local-sign.mjs` for the OpenSSL cross-check that
  pinned it down).
- Instruction data layout: `[num=1][pad][offsets(14)][pubkey(33)][sig(64)][msg]`,
  data section starting at offset 16. Self-contained (`instruction_index` = the
  precompile's own tx index, or `u16::MAX`).

## Browser test (real Phantom + Face ID)

`scripts/passport/faceid-browser-test.html` is a self-contained page that runs the
full flow in a real browser: connect Phantom (devnet), create a Face ID passkey
(WebAuthn biometric gate + WebCrypto P-256), register on-chain, and sign in. Serve
it locally (`npm run passport:serve`) and open the printed URL with Phantom set to
devnet. This is the browser-level validation before the production widget wiring
and the mainnet flip.

## Honest scope

- **Real, replayable, on-chain** P-256 verification on devnet.
- **v1**: the precompile message is the 32-byte challenge — a P-256 key (biometric-
  gated client-side) signs it directly. Full WebAuthn `authenticatorData` /
  `clientDataJSON` parsing on-chain is the audit-scope enhancement, not done yet.
- **Unaudited** test pilot. Identity binding only — no funds custody.
- The **mainnet** vault (`3hbbtjeSrTVYXq6eRwjeofDe2DCPh3n8cfN6kZcQfewi`) still runs
  devnet-mode (no verification) until the in-place `--features mainnet` upgrade.
