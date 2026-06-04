# Design note: salted-leaf commitment for the Solana-anchored receipt tree

**Status:** proposal (no code changed yet)
**Scope:** `packages/liquefy-receipts` (off-chain only)
**Author context:** triggered by review of `src/arweave.ts` + `src/merkle.ts`

---

## 1. The leak

`archiveReceipts()` ([src/arweave.ts:99-100](../src/arweave.ts)) anchors a Merkle
root on Solana whose leaves are, per [src/merkle.ts:44-46](../src/merkle.ts):

```
leaf_i = SHA-256( 0x00 || JSON.stringify(receipt_i) )
```

This is a **deterministic, unsalted hash commitment**. A bare hash `H(m)` hides
`m` only when `m` has high min-entropy. x402 receipts do not:

| field | entropy from an attacker's view |
|---|---|
| `amount` | small set of micropayment tiers |
| `sender` / `receiver` | "small agent pool", receivers "1–8 unique values" (per `compress.ts` header) |
| `timestamp` | bounded to the batch window |
| `programId` | 1–8 unique values |
| `txSignature` | high entropy **but publicly observable on the Solana ledger** |

Crucially, an x402 receipt *describes an on-chain Solana payment*. Signature,
sender, receiver, amount, slot/time, and program are all public ledger data, so
the adversary's "guess space" is effectively the enumerable set of on-chain
payments to the known receivers.

Two concrete attacks follow:

1. **Confirmation / dictionary attack.** Any inclusion proof exposes the raw
   `leaf` (see `MerkleProof.leaf`, [src/merkle.ts:185](../src/merkle.ts)). Given a
   candidate receipt, the adversary recomputes `SHA-256(0x00 || JSON.stringify(candidate))`
   and checks equality — confirming or rejecting the guess offline, with no key.
2. **Full enumeration** of low-entropy leaves (e.g. a single-receipt batch where
   `root == leaf`).

**The AES-256-GCM ciphertext on Arweave is irrelevant to this attack.** The leak
is in the *public commitment*, not the *encrypted blob*. The docstring's claim
that Solana "proves the batch existed... without revealing content"
([src/arweave.ts:4-8](../src/arweave.ts)) does not hold for low-entropy receipts.

---

## 2. The fix: salted (hiding) leaf commitment

Replace the bare leaf with a blinded commitment:

```
leaf_i = SHA-256( 0x00 || SCHEME_V2 || salt_i || canonical(receipt_i) )
```

- `salt_i` — ≥128-bit (recommend 256-bit) high-entropy value, **secret** (never
  published; lives only inside the encrypted blob, see §3).
- `SCHEME_V2` — 1-byte version tag so v1 (unsalted) and v2 (salted) batches can
  never be confused by a verifier.
- The RFC-6962 leaf/internal domain separation (`0x00` vs `0x01`) is preserved —
  the salt goes *inside* the leaf domain, so the second-preimage guard in
  `merkle.ts` is unaffected. Internal nodes, proofs, and the root algorithm do
  **not** change.

Security properties (random-oracle model):

- **Hiding** — `H(m || r)` with secret uniform `r` reveals nothing about `m`; the
  adversary can no longer confirm a guess without `r`. ✓
- **Binding** — SHA-256 collision resistance is unchanged. ✓
- **Selective open** — to prove inclusion of receipt `i`, reveal
  `(salt_i, receipt_i)` + Merkle path; the verifier recomputes the salted leaf and
  checks the path to the public root.

### Why per-leaf salts are mandatory (not one batch salt)

If a single salt `S` were shared across all leaves, then opening *any* leaf would
reveal `S` and re-expose *every other* leaf to brute force. Therefore derive an
**independent, one-way** salt per leaf so revealing one opening leaks nothing
about the others:

```
salt_i = HKDF-Expand(S, "liquefy-leaf-salt-v1" || u32(i), 32)
```

Opening leaf `i` reveals only `salt_i`; `S` and all `salt_{k≠i}` stay protected
by the one-way KDF.

---

## 3. Salt storage / derivation

Storing N independent random salts is a real cost regression: 10k receipts ×
32 B = 320 KB of incompressible data, dwarfing the ~20 KB compressed blob.

**Recommended:** store one 32-byte batch secret `S` in the encrypted blob header
and derive every `salt_i` from it (formula above). Cost is O(1), not O(N), and
the salts stay inside the AES-GCM envelope — so leaf-opening capability is tied to
possession of the archive key, consistent with the existing model (the agent
holds the AES key, `src/arweave.ts:91`).

> Invariant: salts must **never** appear in the on-chain anchor or in plaintext
> Arweave tags. A public salt adds zero hiding.

Avoid deriving `S` directly from the AES key (couples confidentiality and
commitment-hiding under one secret). A dedicated, separately stored `S` is the
cleaner separation.

---

## 4. Coupled must-fix: canonicalization

Salting is necessary but not sufficient — the current leaf preimage is
**non-canonical and already fragile**:

- `JSON.stringify` key order = insertion order; no number/whitespace
  normalization. `verifyReceiptInBatch` ([src/merkle.ts:216](../src/merkle.ts))
  only round-trips if the receipt is reconstructed byte-identically, but
  `decompressReceipts` returns keys in column order and coerces `amount`
  `bigint → Number`. Archive-time and verify-time leaves can silently diverge.
- `amount: number | bigint`, and **`JSON.stringify(bigint)` throws** — a bigint
  amount makes `hashLeaf` throw at archive time today.

The v2 leaf must adopt an explicit canonical encoding (RFC 8785 JCS, or a fixed
field order + typed binary encoding for `amount`/`timestamp`). Adding salt without
fixing this just adds a second way for verification to fail.

---

## 5. Compatibility with the ZK membership proofs (`packages/null-miner-sdk/src/zk/`)

**Answer: the change is independent of, and compatible with, the ZK proofs.**

The ZK layer does **not** consume the liquefy SHA-256 tree. It builds a separate
commitment stack ([null-miner-sdk/src/zk/receipt.ts](../../null-miner-sdk/src/zk/receipt.ts)):

```
receiptCommitment = Poseidon2( Poseidon2(payer, amount), Poseidon2(resource, platform) )   // BN254 field elements
batchRoot         = merkleRootPoseidon(receiptCommitment leaves)
```

verified on-chain by `programs/dark_bn254_gate` (Poseidon commitments / nullifiers
/ root). It never hashes `JSON.stringify(receipt)` and never checks the SHA-256
archive root. Confirmed blast radius of the salted-leaf change:

- **Touched:** `merkle.ts` (`hashLeaf`, `buildReceiptRoot`, `MerkleTree`,
  `verifyReceiptInBatch`), `arweave.ts` (store `S` in the blob), tests, README.
- **Not touched:** any Groth16 witness, Poseidon root, or BN254 verifier. No
  on-chain program parses the SHA-256 leaf — the `receipt_anchor` program stores
  an opaque 32-byte root ([src/anchor.ts:31-40](../src/anchor.ts)).

Two related findings surfaced while confirming this:

1. **Docstring correction.** `arweave.ts:8` ("ZK proofs check against the on-chain
   root") conflates two different roots. The ZK proofs check the *Poseidon* root,
   not the SHA-256 archive root. Fix the comment (or unify — see below).
2. **Same leak on the ZK side.** `receiptCommitment` is **also unsalted** —
   deterministic Poseidon over low-entropy structured inputs — and it is a public
   input in `ReceiptPublicInputs` (with `amountBound` published in cleartext). It
   has the identical confirmation-attack weakness. The shielded-pool layer already
   uses a `blinding` factor (`dark_bn254_gate` note commitments;
   `x402/tests/integration.zk-to-payment.test.ts`), so the pattern exists in-repo
   — the receipt-commitment layer just doesn't apply it. If we fix the privacy
   story, add a blinding field element there too: `Poseidon(..., saltField)`.

**If a single unified root is ever desired** (one anchor serving both archive and
ZK membership): do the salting at the Poseidon layer, not by forcing SHA-256-JSON
leaves into a circuit (SHA-256 ≈ 28K constraints/leaf vs Poseidon ≈ 240).
Recommendation: keep the two trees separate but salt **both**.

---

## 6. Residual leakage (salting does NOT fix)

- **Batch cardinality** — `treeSize` is in every proof and `Receipt-Count` is a
  plaintext Arweave tag (`arweave.ts:139`). Pad to a fixed size or drop the tag if
  count is sensitive.
- **Timing** — anchor tx slot + Arweave upload time bound the batch window.
- **Payer linkage** — the anchoring tx fee-payer is a public Solana signer;
  salting leaves does not unlink the batch from the wallet. That is the
  Semaphore/nullifier layer's job, not this tree's.
- **Other plaintext tags** — `Compression-Ratio` leaks aggregate redundancy;
  `Liquefy-Version`, `App` leak metadata. Consider trimming.
- Opening a leaf still reveals that one receipt — by design.

---

## 7. Sibling instances of the same pattern (flag only — out of scope here)

- `packages/receipt-dag/src/index.ts:270` — `hashLeafBytes(JSON.stringify(r))`,
  same unsalted plaintext leaf in the DAG construction.
- `.clone/parad0x-website/scripts/receipt-anchor-job.mjs` — separate SHA-256 tree
  over bet receipts `{id,userId,amount,outcome,settledAt}`, same pattern (different
  repo / lane).

---

## 8. Recommendation

1. Adopt **salted leaves v2** (per-leaf derived salts + canonical encoding) in
   `packages/liquefy-receipts`. Off-chain only; no on-chain change.
2. Fix the `arweave.ts` docstring to stop claiming the ZK proofs use this root.
3. Separately, add a blinding field element to the ZK `receiptCommitment`.
4. Decide cardinality/tag exposure (pad batches or drop `Receipt-Count`).
