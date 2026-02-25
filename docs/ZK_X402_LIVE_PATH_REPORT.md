# Dark Null ZK / Nullifier in Live x402 Path

## 1) `pdx_dark_protocol` ZK/nullifier instruction surface

Entrypoint:
- `process_instruction` in `src/lib.rs`

Instruction enum:
- `DarkInstruction::Deposit { amount, commitment }`
- `DarkInstruction::Withdraw { proof, root, nullifier_asset, nullifier_fee, new_commitment, asset_id_hash, recipient, amount }`

ZK / nullifier / commitment-related runtime calls inside `Withdraw`:
- `validate_public_inputs(root, nullifier_asset, nullifier_fee, new_commitment, asset_id_hash)`
- `verify_proof(proof, public_inputs)` (Groth16 verifier)
- `verify_nullifier_unused(program_id, null_asset_pda, nullifier_asset)`
- `verify_nullifier_unused(program_id, null_fee_pda, nullifier_fee)`
- `consume_nullifier(program_id, payer, null_asset_pda, system, nullifier_asset)`
- `consume_nullifier(program_id, payer, null_fee_pda, system, nullifier_fee)`

Important implementation notes:
- `root` and `new_commitment` are validated as public inputs, but no on-chain Merkle tree insert/update path is executed in current code.
- `Deposit` currently logs and returns in the instruction match arm; `process_deposit(...)` exists but is not called from the match arm.

## 2) x402 runtime payment trace (`pay/finalize/anchor`)

Runtime chain:
- `x402/src/server.ts`
  -> `verifyPaymentForQuote(...)`
  -> `x402/src/paymentVerifier.ts`
  -> `x402/src/verifier/splTransfer.ts` (transfer mode)
  -> `x402/src/verifier/streamflow.ts` (stream mode)

Observed/implemented Solana operations in live x402 flow:
- Transfer verify path: RPC reads only (`getSignatureStatus`, `getParsedTransaction`, `getBlockTime`).
- Stream verify path: Streamflow client read.
- Netting path: off-chain ledger aggregation.
- Anchoring path: `x402/src/onchain/receiptAnchorClient.ts`
  sends v0 tx to `receipt_anchor` program (`AnchorSingle`/`AnchorBatch` payloads via `buildV0.ts`).

No call in this runtime path invokes `pdx_dark_protocol::Withdraw` Groth16/nullifier instruction today.

## 3) Hard-proof test result

Test:
- `x402/tests/x402.zk.integration.test.ts`

What it proves:
- Executes one paid x402 request (`402 -> proof -> 200`).
- Captures Solana programs observed in verification transaction context.
- Classifies runtime as:
  - `ZK-IN-PATH` if `pdx_dark_protocol` is observed
  - `NOT-IN-PATH` if not observed
  - `UNKNOWN` only if no observable program data (test fails in this case)

Current expected classification:
- `NOT-IN-PATH`

## 4) Final answer

- ZK core present in repository: **YES**
- ZK/nullifier in live x402 pay/finalize path: **NO**

## 5) What wiring is needed to make it YES

1. Add a new x402 settlement mode that explicitly routes through Dark Null withdraw semantics (proof + root + nullifiers + commitment fields).
2. Implement a dedicated on-chain client in x402 that submits the Dark Null `Withdraw` instruction to `pdx_dark_protocol` during finalize (or pre-finalize), not just receipt anchoring.
3. Bind receipt payload to Dark Null tx signature and to proof/nullifier commitments (for replay safety and auditability).
4. Extend verification and error contract to include Dark Null-specific failures (invalid proof, nullifier already used, root mismatch).
5. Add end-to-end tests that assert `pdx_dark_protocol` program invocation and nullifier consumption on successful finalize.
