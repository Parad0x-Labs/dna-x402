# SIMD-0064 Revival PR — Transaction Receipts

## PR Title
`Revival: SIMD-0064 Transaction Receipts — new champions + Groth16 Merkle inclusion extension`

## PR Body (paste into GitHub)

```
## Status

This PR revives SIMD-0064, which has been stagnant since October 2024. The original 
authors (Anoushk Kharangate / Tinydancer, Richard Patel / Jump Crypto) did foundational 
work; we are picking it up as implementation champions.

**New champion:** Parad0x Labs (@sls_0x) — builders of DNA x402, a Solana payment rail 
for AI agent economies. github.com/Parad0x-Labs/dna-x402

## Why we care

AI agents making micropayments via x402 need lightweight, trustless receipt verification. 
Today you either trust an RPC or run a full validator. SIMD-0064 gives a third option: 
a compact proof that a transaction was included in a specific block, verifiable by anyone 
holding the block header.

## What's already live

`receipt_anchor` program on mainnet: `6HSRGivdYR5D7yTDy1TFMCM8h3LzXxRtKU1RA3RnCMRN`

It accumulates 32-byte anchors (SHA-256 of payment receipts) into hourly-windowed 
AnchorBucket PDAs. Each bucket holds a running Merkle root and count. This is the 
application layer that needs SIMD-0064's inclusion proof underneath it.

We also have `dark_bn254_gate` live on mainnet (`GCptvBYF8S6eVYoh15B7WAESc54FUHCpN1Ui6aHeQYZd`) 
— a Groth16 verifier using Solana's native BN254 syscalls — which is the cryptographic 
primitive for the extension proposed below.

## Proposed extension to SIMD-0064

Alongside the existing "simple" inclusion proof variant, we propose a Groth16 Merkle 
inclusion proof variant:

- **Circuit:** proves `leaf ∈ Merkle-tree(block_entries)` without revealing the path
- **Public inputs:** block header hash, leaf hash, tree root
- **Proof system:** Groth16 over BN254 (matches Solana's existing `alt_bn128` syscalls)
- **On-chain verification:** ~200k CU using the native precompile, already demonstrated
- **Use case:** privacy-preserving payment channels and agent-to-agent settlements where 
  position metadata must not leak

## Concrete next steps we are committing to

1. Update SIMD-0064 text to add the ZK variant as an optional extension
2. Implement the Merkle inclusion circuit (Circom, 2-party ceremony already completed 
   for our existing circuits — evidence/zk/ceremony-v2.json)
3. Write RFC-style test vector set against devnet blocks
4. Coordinate with Firedancer / Agave for the block-proof generation interface

## What we are not claiming

Block-proof generation (validator side) is out of our scope — we are focused on on-chain 
verification and the application SDK. We will define the proof interface that validators 
would need to produce, not change Agave/Firedancer internals.

## References
- Original SIMD-0064: https://github.com/solana-foundation/solana-improvement-documents/pull/64
- DNA x402 repo: https://github.com/Parad0x-Labs/dna-x402
- receipt_anchor on mainnet: https://explorer.solana.com/address/6HSRGivdYR5D7yTDy1TFMCM8h3LzXxRtKU1RA3RnCMRN
- Groth16 gate on mainnet: https://explorer.solana.com/address/GCptvBYF8S6eVYoh15B7WAESc54FUHCpN1Ui6aHeQYZd
```

---

## Foundation Email

**To:** grants@solana.org (or via the grants form at solana.org/grants-funding)  
**Subject:** SIMD-0064 revival — x402 payment receipts live on mainnet + grant application

```
Hi,

We opened a PR to revive SIMD-0064 (Transaction Receipts), stagnant since Oct 2024:
[link to PR on solana-improvement-documents]

We're Parad0x Labs (github.com/Parad0x-Labs). Our receipt_anchor program is live on 
Solana mainnet (6HSRGivdYR5D7yTDy1TFMCM8h3LzXxRtKU1RA3RnCMRN) aggregating AI agent 
payment receipts for our x402 payment rail. The missing piece is the block-level 
inclusion proof SIMD-0064 would standardize.

We're also proposing a Groth16 inclusion proof extension using Solana's existing BN254 
syscalls — already exercised in our dark_bn254_gate program.

We have an open grant application ($65k — audit + ZK sprint) and would like to connect 
this SIMD work to that conversation. Happy to set up a call.

— sls_0x / Parad0x Labs
```

---

## Where to submit

1. Fork: https://github.com/solana-foundation/solana-improvement-documents
2. Open a PR updating `proposals/0064-transaction-receipt.md` with the new champion info + ZK variant
3. Tag @samkim-crypto (Anza, SIMD author), @anoushk1234 (original proposer)
4. Send the email to grants@solana.org linking the PR
