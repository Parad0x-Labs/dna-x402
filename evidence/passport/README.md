# Face ID (P-256) Sign-In — Real On-Chain Verification

Reproduce (devnet): `npm run passport:devnet:faceid -- <PROGRAM_ID>`

## What this proves

The `dark_secp256r1_vault` program, built `--features mainnet`, performs **real
on-chain P-256 verification** via the Agave secp256r1 precompile (SIMD-0075).
The devnet harness (`scripts/passport/01-devnet-faceid-e2e.mjs`) checks:

| Step | Expected result |
|------|--------|
| Register — bind a P-256 key (precompile-verified pubkey) | PASS (real tx) |
| Sign-in — bound key signs the live challenge, challenge rotates | PASS (real tx) |
| Negative — wrong message signed | REJECTED `0x400b ChallengeNotSigned` |
| Negative — different P-256 key signs | REJECTED `0x4009 PasskeyPubkeyMismatch` |

`dark_secp256r1_vault` runs on devnet at `GzB2iHxxAbDkpunQiLzgCj9gUEvHL2HpQVzj4JtLzmLC` since 2026-10-06 (4/4 and 3/3,
[evidence](../devnet-2026-10-06/README.md)); the harness takes the program ID as a required argument.

The two negative tests are the point: a valid signature over the *wrong* message,
and a valid signature from the *wrong* key, are both rejected on-chain. The
verification is real, not a presence check.

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
it locally (`npm run passport:serve`) and open the printed URL with
`?program=<PROGRAM_ID>` appended and Phantom set to devnet. This is the browser-level validation before the production widget wiring
and the mainnet flip.

## Honest scope

- **Real, replayable, on-chain** P-256 verification: the harness reruns against any
  deployment named on the command line.
- **v1**: the precompile message is the 32-byte challenge — a P-256 key (biometric-
  gated client-side) signs it directly. Full WebAuthn `authenticatorData` /
  `clientDataJSON` parsing on-chain is the audit-scope enhancement, not done yet.
- **Unaudited** test pilot. Identity binding only — no funds custody.
- No mainnet `dark_secp256r1_vault` deployment is current; the earlier pilot
  deployment and its evidence are withdrawn.
