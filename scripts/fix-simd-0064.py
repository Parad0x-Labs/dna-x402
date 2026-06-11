#!/usr/bin/env python3
"""Fix all 5 Greptile P1 issues in SIMD-0064 PR."""

import sys

path = r"C:\tmp\simd-fork\proposals\0064-transaction-receipt.md"

with open(path, "r", encoding="utf-8") as f:
    content = f.read()

# Fix 1: front-matter status + add author
content = content.replace(
    "  - Harsh Patel (Tinydancer)\ncategory: Standard\ntype: Core\nstatus: Stagnant",
    "  - Harsh Patel (Tinydancer)\n  - sls_0x (Parad0x Labs)\ncategory: Standard\ntype: Core\nstatus: Draft"
)

# Fix 2-5: replace the entire update section
marker_start = "## Update — 2026-05-31"
idx = content.find(marker_start)
if idx == -1:
    print("ERROR: Could not find update section")
    sys.exit(1)

new_section = r"""## Update — 2026-05-31

Picking this up. — sls_0x / Parad0x Labs (https://github.com/Parad0x-Labs/dna-x402)

### Why

We built x402 payment receipts for AI agents on Solana. The application layer
is live on mainnet: `receipt_anchor` (`6HSRGivdYR5D7yTDy1TFMCM8h3LzXxRtKU1RA3RnCMRN`)
anchors 32-byte SHA-256 receipt hashes in hourly Merkle buckets on-chain.
The missing piece is block-level inclusion proof so downstream verifiers do not
have to trust an RPC.

We also have `dark_bn254_gate` (`GCptvBYF8S6eVYoh15B7WAESc54FUHCpN1Ui6aHeQYZd`)
live on mainnet — a Groth16 BN254 verifier using the native `alt_bn128_pairing` syscall,
demonstrated at ~200k CU. This is the on-chain primitive the ZK extension would use.

DNA x402 repo: https://github.com/Parad0x-Labs/dna-x402

### Proposed optional extension: Groth16 Merkle inclusion proof

This is a sketch for discussion, not a finished spec. All open questions are
called out explicitly below.

**Core idea:** prove `tx is in receipt-tree(block)` without revealing the tx's
position in the tree. Verifiable on-chain using the existing `alt_bn128` syscalls.

**Variable block size — fixed-depth solution:**
Groth16 circuits are parameterised at ceremony time and cannot change after.
Solana's transaction count per block varies from 1 to hundreds of thousands,
so the circuit must target a fixed maximum depth. We propose `MAX_DEPTH = 20`
(supports up to 2^20 ≋ 1M transactions). Blocks with fewer transactions pad
empty leaves with `H(0)`. One circuit, one ceremony, covers all valid block
sizes within that bound. Blocks exceeding 2^20 transactions fall back to the
existing hash-chain proof variant.

**Hash function choice (open question for working group):**
SIMD-0064's receipt tree uses SHA-256. SHA-256 inside a Groth16 circuit is
expensive (~27k constraints per hash). A ZK-friendly hash (e.g. Poseidon over
BN254) reduces this ~100x but produces a different root — it cannot reuse the
SHA-256 receipt tree directly. Two paths: (a) keep SHA-256, accept the
constraint cost, use the existing tree root; (b) define a parallel Poseidon
commitment in the block header alongside the SHA-256 hash. We are not deciding
this here. The correct answer requires input from the validator teams on what
they can feasibly commit in the header.

**Block-header commitment (requires validator input):**
For a verifier to use an inclusion proof, the receipt tree root must appear in
a block-header field that light clients can trust. SIMD-0064 already requires
validators to compute the receipt tree — this extension additionally requires
that root to appear in a committed header field. Specifying which field is
validator-side work outside our scope, and a prerequisite before this extension
can be deployed end-to-end.

**Ceremony (separate from existing circuits):**
Our existing circuits (`null_proof`) have a 2-party ceremony at
https://github.com/Parad0x-Labs/dna-x402/blob/main/evidence/zk/ceremony-v2.json.
That ceremony is for a different circuit. The Merkle inclusion circuit does not
exist yet and will need its own separate ceremony. Trust model for 2-party: if
either participant destroyed their toxic waste, the setup is sound. For a
financial use case we would run a larger public ceremony.

**Proposed public inputs:**
- `receipt_tree_root` — root of the fixed-depth receipt tree (Poseidon or SHA-256 TBD)
- `tx_hash` — hash of the transaction receipt
- `block_header_hash` — binds the proof to a specific block

**What we are not touching:**
Agave or Firedancer internals. Validators need to build the fixed-depth tree
at block production and commit the root to a header field — that is outside our
scope. We own the on-chain verifier and client SDK.

### What we're committing to

1. Resolve the hash function question with the working group (SHA-256 vs Poseidon)
2. Formalise MAX_DEPTH and the empty-leaf padding rule
3. Define which block-header field carries the receipt tree root (needs validator input)
4. Implement the fixed-depth Merkle inclusion circuit (Circom)
5. Run a public multi-party ceremony for the new circuit
6. Write test vectors against devnet blocks"""

# Replace from the marker to end of file (the section runs to EOF)
content = content[:idx] + new_section

with open(path, "w", encoding="utf-8") as f:
    f.write(content)

print("done")
