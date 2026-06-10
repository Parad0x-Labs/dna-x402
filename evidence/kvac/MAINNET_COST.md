# KVAC — mainnet launch cost

All figures derived from the live devnet deploy + `solana rent`. Rent rates are a
protocol constant — **identical on mainnet and devnet** — so these are exact, not
estimates. USD shown at an assumed **SOL ≈ $180** (mark-to-market before acting).

The architecture (spec §6.2) is what makes this cheap: the KVAC **verifier runs
off-chain in the gateway** (it holds the secret key it already owns), so there is
**no on-chain verifier, no per-call proof-verification CU**. The only thing that
touches the chain is the single-use nullifier record.

## One-time (go-live)

| Item | SOL | ~USD | Note |
|---|---|---|---|
| Deploy `dark_nullifier_record` (74,680-byte program) | **0.5225** | ~$94 | measured on devnet; rent-exemption of the program account |
| Deploy tx fees | ~0.00003 | <$0.01 | a few signatures |
| **Total one-time** | **≈0.52 SOL** | **≈$94** | **or ~0** if you reuse an existing nullifier-record program already on mainnet |

## Per paid x402 call (recording one nullifier)

| Item | SOL | ~USD | Note |
|---|---|---|---|
| Nullifier PDA rent-exempt (41 bytes) | **0.00117624** | ~$0.21 | **recoverable** — locked, not burned; returns if the record account is ever closed |
| Base tx fee | 0.000005 | ~$0.0009 | the only truly *spent* lamports |
| **Per call** | **≈0.00118 SOL** | **≈$0.21** | rent dominates and is reclaimable |

Truly burned cost per call is just the **0.000005 SOL** tx fee; the 0.00117624 is
rent-exempt capital that comes back if a context's records are GC'd.

### At scale

| Calls | Locked rent (SOL) | Burned fees (SOL) |
|---|---|---|
| 1,000 | 1.18 | 0.005 |
| 100,000 | 117.6 | 0.5 |
| 1,000,000 | 1,176 | 5 |

**Optimization (v2):** route the nullifier into a **ZK-compressed account**
(Light Protocol — already explored in this repo, task #15) and the per-call rent
drops ~100–1000×, taking a million nullifiers from ~1,176 SOL to single-digit SOL.
Recommended before any high-volume mainnet launch.

## What "launch" actually gates on (honest)

The SOL cost is trivial. The real gate is **not** money:

1. **Audit.** The construction is sound in the **generic group model** (MAC_GGM,
   CMZ Thm 2) with a **DDH/ROM** nullifier PRF — that is the right model, but it is
   **unaudited**. Before real value or identity rides on it, the gateway verifier +
   the nullifier program want an external review. Never ship it as "audited".
2. **Gateway hosting** (off-chain): a standard server running the verifier with
   `sk`. Ordinary cloud cost, not a Solana cost. Key custody (the issuer `sk`)
   should sit behind the same discipline as the other authority keys (HSM / multisig
   for issuer-key rotation).
3. **Blind issuance + tier predicate** (the two `[ ]` items) if the product needs
   attribute privacy at issuance or on-chain tier gating.

## Bottom line

- **Go live on mainnet today (devnet-equivalent posture): ≈0.52 SOL (~$94) one-time
  + ≈$0.21 recoverable per call.**
- The blocker is an **audit**, not budget. The crypto is built, devnet-proven, and
  the on-chain cost is near-zero by design.
