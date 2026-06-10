# KVAC scheme — canonical spec

MAC_GGM keyed-verification anonymous credential + per-context nullifier over
ristretto255. Reconciled from independent derivations against the **verbatim**
primary source (Signal/CPZ eprint 2019/1416 §3.1–3.2) and the shipped
`dark_fedimint_redeem::curve_syscall` template.

Additive notation: `+`=ADD, `-`=SUB, `k*P`=scalar-MUL. Points = 32-byte compressed
Ristretto; scalars = 32-byte canonical LE. `q` = group order.

## Part 1 — parameters

```
H2C(domain,label) = RistrettoPoint::from_uniform_bytes(SHA512(domain ‖ label))
GEN_DOMAIN  = "DNAx402/KVAC/v1/gen"      NULL_DOMAIN = "DNAx402/KVAC/v1/nullctx"
```
12 generators, all NUMS via `H2C(GEN_DOMAIN, ·)` except `G`:
`G` (basepoint const), `Gw, Gw', Gx0, Gx1, Gy1, Gy2, Gy3` (blinding bases),
`Gm1, Gm2, Gm3` (value bases), `GV`.

Attributes (n=3): `m1=tier (u8)`, `m2=spend_cap (u64)`, `m3=ms (secret scalar)`.
`Mi = mi·Gmi`. Per-context base `H_ctx = H2C(NULL_DOMAIN, context)`, `context` =
fixed 32 bytes; **the verifier always recomputes `H_ctx`, never trusts a client base.**

## Part 2 — issuer keygen

```
sk = (w, w', x0, x1, y1, y2, y3) ∈ Z_q          W = w·Gw
CW = w·Gw + w'·Gw'
I  = GV − (x0·Gx0 + x1·Gx1 + y1·Gy1 + y2·Gy2 + y3·Gy3)
```
`iparams = (CW, I)` published; `sk` held only by the gateway.

## Part 3 — issuance (clear-attribute)

Agent sends `M3 = ms·Gm3` + a Schnorr PoK of `ms` (so the gateway never learns `ms`).
Issuer picks `t ∈_R Z_q`, `U = H2C("U", nonce)` (real element, unknown dlog):
```
V = W + (x0 + x1·t)·U + y1·M1 + y2·M2 + y3·M3        credential = (t, U, V)
```
Issuance proof π_I (agent checks it) over the 7 secrets, statements `CW`, `I`, and
`V = w·Gw + x0·U + x1·(t·U) + Σ yi·Mi`; FS domain `"DNAx402/KVAC/v1/issue"`.

## Part 4 — presentation

Holder picks `z ∈_R Z_q`, `z0 = −t·z`. Commit:
```
Cx0 = z·Gx0 + U      Cx1 = z·Gx1 + t·U      CV = z·GV + V
Cyi = z·Gyi + mi·Gmi          (i = 1,2,3)
n   = ms·H_ctx
```
Sigma proof (witness `z, z0, m1, m2, ms, t`), relations:
```
P1  Z   = z·I                          (verifier computes Z with sk, below)
P2  Cx1 = t·Cx0 + z0·Gx0 + z·Gx1        ← z0 on Gx0, z·Gx1 present
P3  Cy1 = m1·Gm1 + z·Gy1
P4  Cy2 = m2·Gm2 + z·Gy2
P5  Cy3 = ms·Gm3 + z·Gy3
P6  n   = ms·H_ctx                      ← same ms as P5
```
Nonces `r_z, r_z0, r_t, r_m1, r_m2, r_ms` — **`r_z` shared across A2..A5**,
**`r_ms` shared across A5,A6**. Announcements:
```
A1 = r_z·I
A2 = r_t·Cx0 + r_z0·Gx0 + r_z·Gx1
A3 = r_m1·Gm1 + r_z·Gy1
A4 = r_m2·Gm2 + r_z·Gy2
A5 = r_ms·Gm3 + r_z·Gy3
A6 = r_ms·H_ctx
```
Challenge — FS domain `"DNAx402/KVAC/v1/present"`, then, concatenated:
`12 gens ‖ CW ‖ I ‖ context(32B) ‖ H_ctx ‖ Cx0 ‖ Cx1 ‖ Cy1 ‖ Cy2 ‖ Cy3 ‖ CV ‖ n ‖
u32_le(len(revealed)) ‖ revealed ‖ A1..A6`; `e = from_bytes_mod_order_wide(SHA512(…))`.
Responses `s_x = r_x + e·x` for each secret.

### Verifier (gateway, holds sk)
```
H_ctx = recompute from context
Z  = CV − (W + x0·Cx0 + x1·Cx1 + y1·Cy1 + y2·Cy2 + y3·Cy3)      [proves Z = z·I]
A1' = s_z·I            − e·Z
A2' = s_t·Cx0 + s_z0·Gx0 + s_z·Gx1   − e·Cx1
A3' = s_m1·Gm1 + s_z·Gy1             − e·Cy1
A4' = s_m2·Gm2 + s_z·Gy2             − e·Cy2
A5' = s_ms·Gm3 + s_z·Gy3             − e·Cy3
A6' = s_ms·H_ctx                     − e·n
accept iff e == SHA512-challenge(transcript with A1'..A6')  AND n unused
```
Revealed attribute `j`: fold `Cyj ← Cyj + mj·Gmj` before computing `Z`.

The identity that makes `Z = z·I` hold (verified by hand and by test): the `sk`-fold
of the commitments cancels `V` and leaves `z·(GV − x0·Gx0 − x1·Gx1 − Σ yi·Gyi) = z·I`.

## Part 5 — nullifier

`n = ms·H_ctx`. Deterministic in `(ms, context)` ⇒ one nullifier per identity per
context. Different contexts → independent oracle points → unlinkable under DDH.
Bound to the committed `ms` by the shared-nonce DLEQ (P5↔P6). On-chain: record `n`
single-use via `dark_nullifier_record`, PDA seed `[b"null_record", n]`.

## Part 6 — deployment & feasibility

Verifier needs `sk` ⇒ runs **in the gateway** (off-chain); only `n` goes on-chain.
Verifier cost if ever moved on-chain: ≈18 MUL + 17 ADD/SUB + 2 SHA-512 ≈ 120–227k CU
(prepend `ComputeBudget setComputeUnitLimit(350_000)`; probe `multiscalar_mul`
availability, keep plain group-op path as fallback). No on-chain scalar inversion;
no secret-scalar mult beyond `sk·commitment`.

## Cross-check record (danger zones, resolved against the source)

1. **P2 base** — `z0` multiplies **Gx0** (not Gx1) and the `z·Gx1` term is present.
   (Signal §3.2 verbatim `Cx1 = Cx0^t · Gx0^z0 · Gx1^z`.) One independent derivation
   got this wrong; the source settles it.
2. **Keyed vs keyless** — adopt the keyed `Z=z·I` verifier (uses sk). A "keyless"
   variant proposed in derivation is unsound (its algebra doesn't close; it smuggles
   back the secret-key mult). "No sk on-chain" is achieved by verifying in the
   gateway, not by a keyless scheme.
3. **Revealed attribute** — verifier adds `yj·Mj` back (`(Cyj·Mj)^yj`).
4. **Nullifier binding** — `r_ms` MUST be shared across A5/A6 (one response `s_ms`);
   independent nonces would let a forger emit `ms'·H_ctx`. Non-negotiable.
5. **FS completeness** — every public point in the transcript; 32-byte fixed fields,
   u32-LE length prefix on the only variable field (`revealed`).

## Modeling caveats

MAC_GGM unforgeability holds in the **generic group model** (CMZ Thm 2). The
nullifier PRF `ms·H2C(ctx)` is pseudorandom under **DDH** in ROM. Disclose both;
never call it "audited" or unconditionally sound.

Sources: Signal Private Group System (eprint 2019/1416) §3.1–3.2; CMZ Algebraic MACs
(eprint 2013/516); gdanezis/petlib `amacs.py`.
