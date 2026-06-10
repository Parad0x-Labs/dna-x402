# dark-kvac

**Keyed-verification anonymous credentials (MAC_GGM over ristretto255) for x402.**
A ceremony-free, pairing-free, anonymous-but-accountable credential — the
cryptographic article that supersedes the SHA-256 `dark-anon-credential*` stubs.

> Status: **DEVNET / library, UNAUDITED, never mainnet.** Unforgeability holds in
> the generic-group model (CMZ Thm 2); the nullifier PRF is pseudorandom under DDH
> in the random-oracle model. Not a security claim of soundness against a real
> adversary — disclose this everywhere.

## Why this exists

An x402 gateway issues a credential once to an authenticated agent, then verifies
every later paid call. Three existing approaches don't fit:

- **Groth16 credential** → needs a trusted-setup ceremony.
- **BBS+ / PS credential** → needs a pairing (no cheap pairing on Solana).
- **The repo's `dark-anon-credential*` crates** → a "presentation proof" that is
  just `SHA256(...)` proves nothing in zero knowledge and is trivially linkable.

**Keyed verification** (Chase–Meiklejohn–Zaverucha, *Algebraic MACs and
Keyed-Verification Anonymous Credentials*, CCS 2014 / eprint 2013/516; instantiated
over ristretto255 by the Signal Private Group System, eprint 2019/1416) fits
exactly: the **issuer is the verifier**, so verification uses the secret key — no
ceremony, no pairing, just a handful of Ristretto group-ops + one SHA-512. Same
`curve25519-dalek` 3.2.1 and the same `sol_curve_*` syscall path the eNULL eCash
rail already uses.

## Properties

| | |
|---|---|
| **Issuance** | clear-attribute (gateway already knows the agent at issue time); `ms` withheld via `M3 = ms·Gm3` + a PoK so the gateway can't precompute nullifiers. Blind issuance is a documented v2. |
| **Presentation unlinkability** | two shows of one credential — and a show vs its issuance — are unlinkable to everyone incl. the gateway, except via the intended nullifier. |
| **Accountability** | per-context nullifier `n = ms·H_ctx` with a correctness proof ⇒ one action per identity per context (the Sybil bound GhostScore / one-`.null`-per-human needs). |

## Construction (3 attributes: `tier`, `spend_cap`, `ms`)

- **MAC** (eq 6): `V = W + (x0 + x1·t)·U + Σ yi·Mi`, credential `(t, U, V)`.
- **iparams** (eq 5): `CW = w·Gw + w'·Gw'`, `I = GV − (x0·Gx0 + x1·Gx1 + Σ yi·Gyi)`.
- **Presentation** blinds with fresh `z`, commits `Cx0,Cx1,{Cyi},CV`, and proves a
  sigma over relations P1–P6:
  - `Z = z·I` where the verifier recomputes `Z = CV − (W + x0·Cx0 + x1·Cx1 + Σ yi·Cyi)` with `sk`.
  - `Cx1 = t·Cx0 + z0·Gx0 + z·Gx1` with `z0 = −tz` (**Gx0** for z0 — the forgery-critical base).
  - each `Cyi` well-formed.
  - `n = ms·H_ctx` for the **same** `ms` committed in `Cy3`, bound by a **shared
    nonce** `r_ms` across the `Cy3` and `n` announcements.
- **Fiat–Shamir**: `e = from_bytes_mod_order_wide(SHA512(domain ‖ 12 gens ‖ CW ‖ I ‖
  context ‖ H_ctx ‖ 6 commitments ‖ n ‖ predicate ‖ 6 announcements))`. Every public
  point binds, or the proof is forgeable.

Full derivation + the cross-checked danger zones are in `SCHEME.md`.

## Deployment (spec §6.2)

Keyed verification needs `sk`, so the verifier runs **in the gateway** (off-chain),
which already holds `sk`. The **on-chain program only records the nullifier**
single-use (reuse `dark_nullifier_record`). That gives the "no secret key on-chain"
property *soundly*, without inventing a keyless scheme. Verifier CU if ever moved
on-chain: ≈18 MUL + 17 ADD/SUB + 2 SHA-512 ≈ 120–227k CU (well under budget).

## Status of this crate

- [x] `group`, `fs` — H2C, NUMS generators, canonical transcript.
- [x] `keys` — issuer keygen + `iparams`.
- [x] `issue` — clear-attribute MAC, issuance proof π_I, `ms` PoK.
- [x] `present` — the unlinkable presentation prover.
- [x] `verify` — the keyed host verifier.
- [x] `nullifier` — `n = ms·H_ctx`.
- [x] 26 tests green (roundtrip, `Z=z·I`, per-component tamper-reject, forged-MAC,
      wrong-attribute, param-swap, forged-nullifier, wrong-context, determinism,
      cross-context, unlinkability, wire roundtrip + non-canonical reject).
- [x] wire (de)serialization (448 bytes) with canonical-encoding checks on every field.
- [x] host e2e binary (`kvac_e2e`) — issue → present → verify (×2 contexts) + adversarial checks.
- [x] **devnet-proven**: nullifiers recorded via `dark_nullifier_record`
      (`AFTuz5s58FEwQoQBxAdvWFrXAVnS9XzC43XQgL2Canpg`); replay reverts `AlreadyRecorded`
      (Custom 10). Evidence in `evidence/kvac/`.
- [ ] tier predicate (set-membership); blind issuance (v2); external audit before mainnet value.

Run: `cargo test -p dark-kvac` · `cargo run -p dark-kvac --bin kvac_e2e` · `node scripts/kvac/devnet-record-e2e.mjs`.

Mainnet cost: see `evidence/kvac/MAINNET_COST.md` (≈0.52 SOL one-time deploy + ≈0.00118 SOL recoverable rent per paid call; verifier is off-chain so no per-call CU).
