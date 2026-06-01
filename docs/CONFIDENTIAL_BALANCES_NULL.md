# Confidential Balances — NULL Token Integration Spec

**Status:** Specification  
**Updated:** 2026-06-01  
**Author:** Parad0x Labs  
**Relates to:** `programs/null_token_hook`, `x402/src/paymentVerifier.ts`, `x402/src/types.ts`, `crates/dark-confidential-transfer`, `crates/confidential-amount-watch`

---

## 1. What Confidential Balances Provides

Confidential Balances is a Token-2022 extension set shipped by Helius and live on Solana mainnet. $AUSD is the first production user. It builds on the ElGamal public-key encryption scheme with Pedersen commitments to hide amounts at the protocol level while preserving verifiability.

### 1.1 Transfer Amount Encryption

Every token transfer instruction carries an ElGamal-encrypted ciphertext of the transfer amount instead of a plaintext `u64`. An observer reading the transaction can confirm:

- A transfer occurred between `sender_token_account` and `recipient_token_account`
- The transaction was signed by the sender's authority
- A valid ZK proof of correct range was attached

The observer **cannot** read the amount.

The encryption uses a twisted-ElGamal scheme: the ciphertext is `(r·G, amount·H + r·PK_recipient)` where `G` and `H` are independent generators and `PK_recipient` is the recipient's ElGamal public key. Only the holder of the matching private key can decrypt.

### 1.2 Account Balance Encryption

Each Token-2022 token account stores a `pending_balance_ciphertext` and an `available_balance_ciphertext` instead of a plaintext balance. The account holder decrypts their balance locally with their ElGamal private key. Third parties — including indexers, competitors, and block explorers — see only opaque ciphertexts.

An auditor granted a separate auditor decryption key can decrypt all balances for that auditor key without needing the account holder's private key. This is the compliance path.

### 1.3 `confidential_transfer_fee`

The `ConfidentialTransferFee` extension (a companion to `ConfidentialTransfer`) encrypts the fee deduction from each transfer. Without it, fees are visible even when amounts are hidden — an observer could infer upper bounds on transfer amounts by watching fee deductions. With it enabled, the fee amount is also an ElGamal ciphertext, closing that side channel.

### 1.4 Payee Verifiability

Payee verification works via ElGamal decryption. The recipient holds a private ElGamal key paired to the public key registered on their token account. After a confidential transfer, they call `ApplyPendingBalance` to move the pending ciphertext into the available balance — this requires local decryption + a ZK proof that the resulting balance is consistent. The payee can produce a signed plaintext amount + decryption witness to prove receipt to any auditor without revealing the key.

---

## 2. NULL Token Integration Design

### 2.1 Motivation

The current NULL token (`8EeDdvCRmFAzVD4takkBrNNwkeUTUQh4MscRK5Fzpump`) is standard SPL. Its transfers are fully transparent on-chain. Any chain observer can:

- Sum all outgoing NULL transfers from a known agent wallet over a time window and derive the agent's weekly burn rate
- Sum all inflows to the protocol treasury and derive protocol revenue in real time
- Price the DNA x402 rail by watching agent spending patterns
- Estimate staker yield before it is published

Confidential Balances removes all of these observation vectors. The competitive moat is cryptographic, not procedural.

### 2.2 NULL Mint Migration

The existing SPL mint cannot be upgraded to Token-2022 in place. A new Token-2022 mint is required. The migration path:

1. Deploy a new Token-2022 mint (`NULL_V2`) with extensions initialized at mint creation:
   - `ConfidentialTransfer` — required
   - `ConfidentialTransferFee` — required (closes fee side channel)
   - `TransferHook` pointing to the existing `null_token_hook` program (`14ivonrNRmaMbJMQkGdHVVTcqZYhNvchULWxveazhW2g`) — preserves ZK gating logic
   - `MintCloseAuthority` — treasury multisig retains this
   - `MetadataPointer` — same symbol, name, URI as current NULL

   **Note:** `confidential-amount-watch/src/lib.rs` already documents that `ConfidentialTransfer` is incompatible with bare `TransferFee` but compatible with `ConfidentialTransferFee`. The hook compatibility flag `confidential_compatible_with_hook()` in that crate currently returns `false` — this must be resolved before mainnet migration (see Section 5).

2. Publish a migration program that accepts `NULL_V1` deposits and mints `NULL_V2` at 1:1, time-locked to a 90-day migration window.

3. Staker accounts, agent wallets, and the protocol treasury each generate an ElGamal keypair and register the public key on their new `NULL_V2` token account via `ConfigureAccount`.

4. The NULL treasury registers an auditor ElGamal key on the mint via `SetAuthority`. This key can decrypt any account balance for compliance purposes without exposing individual private keys.

### 2.3 x402 Payment Flow with Confidential Amounts

Current flow:

```
agent → SplTransfer(amount_plaintext) → API endpoint
         └── paymentVerifier.ts reads amount from parsed tx
```

New flow:

```
agent → ConfidentialTransfer(amount_ciphertext, range_proof) → API endpoint
         └── paymentVerifier.ts receives ConfidentialReceipt
              └── payee decrypts locally → verifies range proof → issues signed plaintext
```

The key change: the DNA x402 `paymentVerifier.ts` currently calls `verifySplTransferProof` which reads a plaintext `u64` from the parsed transaction. Under Confidential Balances, the payee's server holds the ElGamal private key and decrypts the pending balance delta to extract the plaintext amount after `ApplyPendingBalance`.

### 2.4 What Competitors Cannot See

A competitor monitoring the chain after this migration observes:

| Data point | Before migration | After migration |
|---|---|---|
| Agent paid API | visible | visible |
| Amount paid | visible | hidden (ElGamal ciphertext) |
| Agent weekly burn rate | derivable | not derivable |
| Protocol fee collected | visible | hidden |
| Staker yield per epoch | derivable from fee visibility | not derivable |
| Agent budget exhaustion timing | derivable | not derivable |
| Number of distinct APIs called | visible | visible |

Metadata that remains visible regardless: sender account, recipient account, timestamp, slot, transaction signature, and the existence of a range proof (but not the value it proves).

### 2.5 NULL Staker Accounting Privacy

Staker reward distributions flow through the NULL treasury. With `ConfidentialTransfer` on the `NULL_V2` mint, each staker's reward ciphertext is visible only to that staker's ElGamal key. Nobody can reconstruct total reward emissions by summing on-chain data. The treasury retains the auditor key to produce aggregate proofs for regulatory purposes.

### 2.6 Audit Path

The NULL treasury publishes quarterly ZK range proofs of solvency: proofs that total `NULL_V2` supply equals sum of all encrypted balances, without revealing individual balances. This is the standard Proof-of-Reserves path for confidential token systems. The auditor decryption key is kept in the treasury multisig (`9M949AfyYCHp9hUk7crZZx3N6Y8sigyWBN6RM6tFq1q5` + co-signers) and used only for compliance decryption.

---

## 3. What Needs Building

### 3.1 NULL_V2 Token-2022 Mint

**Files to create/modify:**

- `scripts/null-v2/01-deploy-null-v2-mint.ts` — deploy Token-2022 mint with `ConfidentialTransfer`, `ConfidentialTransferFee`, `TransferHook`, `MetadataPointer` extensions
- `scripts/null-v2/02-configure-treasury-elgamal.ts` — generate treasury ElGamal keypair, call `ConfigureAccount` on treasury token account, set auditor key on mint
- `scripts/null-v2/03-migration-program-deploy.ts` — deploy migration escrow that accepts `NULL_V1`, mints `NULL_V2`

**Dependency resolution required:**

The `confidential-amount-watch` crate (`crates/confidential-amount-watch/src/lib.rs`) currently marks `ConfidentialTransfer` incompatible with `TransferHook`. This reflects the upstream Token-2022 behavior as of mid-2025. Before deploying `NULL_V2`, verify whether Solana Labs has resolved this incompatibility in the runtime version live on mainnet at deployment time. If it remains incompatible, the `TransferHook` allowlist enforcement must be implemented via a different mechanism (e.g., a `ConfidentialTransfer` pre-instruction hook via the `WithheldAmountElGamalPubkey` path or moved into the `ConfidentialTransferFee` authority).

### 3.2 Updated Payment Verifier

**File:** `x402/src/paymentVerifier.ts`

Add a new verification path to `SolanaPaymentVerifier.verify()`:

```typescript
case "confidential_transfer":
  return this.verifyConfidentialTransfer(
    quote,
    paymentProof.txSignature,
    paymentProof.confidentialReceipt
  );
```

The `verifyConfidentialTransfer` method:

1. Fetches the transaction to confirm it landed and is finalized
2. Validates the transaction includes a `ConfidentialTransfer` instruction to the correct recipient token account
3. Calls the payee-side ElGamal decryption service (local to the API server, never exposed externally) to decrypt the pending balance delta
4. Checks the decrypted amount against `quote.totalAtomic`
5. Verifies the range proof embedded in the transaction (via `@solana/spl-token` Token-2022 helpers)
6. Returns `VerificationResult` with `settledOnchain: true`

### 3.3 `ConfidentialReceipt` Type

**File:** `x402/src/types.ts`

Add alongside the existing proof types:

```typescript
export interface ConfidentialTransferPaymentProof {
  settlement: "confidential_transfer";
  txSignature: string;
  confidentialReceipt: ConfidentialReceipt;
}

export interface ConfidentialReceipt {
  // The ElGamal ciphertext of the transfer amount from the tx instruction data
  amountCiphertextHex: string;
  // The ZK range proof bytes (Sigma or Bulletproof, depending on Token-2022 version)
  rangeProofHex: string;
  // The payee's ElGamal public key used for this transfer (hex)
  recipientElGamalPubkeyHex: string;
  // Slot when transfer was processed
  settlementSlot: number;
  // Plaintext amount — populated server-side after ElGamal decryption; never sent by client
  decryptedAmountAtomic?: AtomicAmount;
}
```

Update the `PaymentProof` union:

```typescript
export type PaymentProof =
  | TransferPaymentProof
  | StreamPaymentProof
  | NettingPaymentProof
  | ConfidentialTransferPaymentProof;
```

Update `ReceiptPayload` to carry an optional `confidentialReceipt` field so the receipt anchor includes a commitment to the encrypted amount, allowing downstream audit.

### 3.4 `receipt_anchor` Program Update

**Program:** `programs/receipt_anchor` (mainnet: `6HSRGivdYR5D7yTDy1TFMCM8h3LzXxRtKU1RA3RnCMRN`)

The current `AnchorBucket` stores a 32-byte Merkle root of receipt hashes. No change to the on-chain layout is required. The `anchor32` field passed from `ReceiptAnchorClient.sendSingle()` should be the SHA-256 of the `ConfidentialReceipt` struct (including the ciphertext and range proof bytes) rather than the plaintext amount. This means the on-chain anchor commits to the encrypted receipt without revealing the amount.

**Change in `receiptAnchorClient.ts`:** When building confidential receipts for anchoring, hash the `ConfidentialReceipt` JSON (canonical, sorted keys) to produce the `anchor32`. This is a calling-convention change, not a program upgrade — the on-chain `receipt_anchor` program accepts any 32-byte value.

### 3.5 `crates/dark-confidential-transfer` Update

The existing crate (`crates/dark-confidential-transfer/src/lib.rs`) implements a SHA-256-based commitment scheme as a placeholder (`mainnet_ready: false` throughout). Update it to wire to the actual Token-2022 ElGamal ciphertexts:

- Add `elgamal-zk` feature flag gating the real twisted-ElGamal encryption path
- Implement `encrypt_amount(amount: u64, recipient_pubkey: ElGamalPubkey, blinding: Scalar) -> ConfidentialCiphertext`
- Implement `decrypt_amount(ciphertext: ConfidentialCiphertext, private_key: ElGamalSecretKey) -> u64`
- Implement `verify_range_proof(ciphertext: &ConfidentialCiphertext, proof: &RangeProof) -> bool`
- Set `mainnet_ready: true` on structs once the real cryptography is wired

Depends on `spl-token-2022` crate (version ≥ 3.0) for the `zk-token-sdk` types.

---

## 4. Competitive Moat

Competitors attempting to price the DNA x402 rail after this migration face a fundamental information barrier:

- Agent wallets show only a stream of confidential transfers; amount aggregation is impossible without the agent's ElGamal private key
- Protocol revenue is not derivable from chain data; treasury inflows are ciphertexts
- NULL burn rate per agent is private; cost-per-call benchmarking by competitors requires their own agent to run on the rail
- Staker yield is private; secondary market pricing of NULL staking positions must rely on self-reported data or projections, not chain surveillance

This is distinct from obfuscation (which can be reversed) — it is cryptographic privacy. The only entity that can decrypt is the account holder and any auditor explicitly granted a decryption key. A well-resourced competitor with full chain history cannot recover amounts without breaking ElGamal, which requires solving the discrete logarithm problem.

The moat compounds: as agent wallets accumulate encrypted history, the historical spending patterns that would normally be visible on a transparent chain become permanently opaque to anyone without the decryption keys.

---

## 5. Implementation Order

### Phase 1 — Specification (current)

- This document
- Verify Token-2022 `ConfidentialTransfer` + `TransferHook` compatibility status on current mainnet runtime
- Resolve `crates/confidential-amount-watch` incompatibility flag before proceeding

### Phase 2 — Testnet

- Deploy `NULL_V2` Token-2022 mint on devnet with all extensions
- Configure treasury and two test agent wallets with ElGamal keypairs
- Run a complete x402 payment flow: agent → API → confidential transfer → payee decryption → receipt issued
- Update `x402/src/paymentVerifier.ts` with `confidential_transfer` path
- Add `ConfidentialReceipt` to `x402/src/types.ts`
- Test `receipt_anchor` anchoring of confidential receipts

### Phase 3 — Migration Tool

- Deploy migration escrow program on devnet, then mainnet
- Build CLI: `scripts/null-v2/migrate.ts` — accepts `NULL_V1` balance, returns `NULL_V2`
- 90-day migration window from migration program deploy date
- Communicate ElGamal key generation instructions to stakers and agent operators

### Phase 4 — Mainnet

- Deploy `NULL_V2` mint on mainnet-beta
- Open migration
- Update all production agent configurations to use `NULL_V2` mint address and `confidential_transfer` settlement path
- Publish first ZK range proof of solvency (audit path)

---

## 6. Open Questions

| Question | Status |
|---|---|
| Is `ConfidentialTransfer` + `TransferHook` compatible on current mainnet runtime? | Must verify — `confidential-amount-watch` crate says incompatible as of spec date |
| Does `ApplyPendingBalance` need to be called by the payee server synchronously, or can verification be deferred? | Needs Token-2022 runtime testing |
| What ElGamal key derivation scheme for agents? (BIP-32 style from wallet seed, or separate keygen) | Architecture decision — recommend deriving from PRF output (see `GOBLIN_ENGINEERING_ROADMAP.md` §1 WebAuthn PRF path) |
| Regulatory treatment of confidential transfers in key jurisdictions | Legal review required before mainnet migration |
| `code-423n4/2025-08-solana-foundation` audit of ZK ElGamal — has it concluded and been applied to the current runtime? | Must verify before mainnet Phase 4 |

---

## 7. Key References

| Item | Location |
|---|---|
| Existing confidential transfer crate | `crates/dark-confidential-transfer/src/lib.rs` |
| Confidential amount watch / compatibility matrix | `crates/confidential-amount-watch/src/lib.rs` |
| Payment verifier | `x402/src/paymentVerifier.ts` |
| Payment proof types | `x402/src/types.ts` |
| Receipt anchor client | `x402/src/onchain/receiptAnchorClient.ts` |
| null_token_hook program | `programs/null_token_hook/` (mainnet: `14ivonrNRmaMbJMQkGdHVVTcqZYhNvchULWxveazhW2g`) |
| receipt_anchor program | `programs/receipt_anchor/` (mainnet: `6HSRGivdYR5D7yTDy1TFMCM8h3LzXxRtKU1RA3RnCMRN`) |
| Current NULL_V1 mint | `8EeDdvCRmFAzVD4takkBrNNwkeUTUQh4MscRK5Fzpump` (standard SPL, transparent) |
| Treasury authority | `9M949AfyYCHp9hUk7crZZx3N6Y8sigyWBN6RM6tFq1q5` |
| Dark NULL privacy layer context | `docs/DARK_NULL_PRIVACY_PATH.md` |
| Goblin engineering roadmap | `docs/GOBLIN_ENGINEERING_ROADMAP.md` |
