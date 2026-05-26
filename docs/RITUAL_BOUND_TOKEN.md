# Money With a Bouncer

Most tokens move when a signer approves. A Ritual-Bound Token moves only when the whole transaction ceremony is valid.

## What Is a Ritual-Bound Token?

A standard Token-2022 transfer requires a signer's approval. A Ritual-Bound Token requires more: the entire transaction must pass a Dark Null ritual grammar check. The token itself is the bouncer. No correct ceremony, no movement.

## The 7 Solana Runtime Features

### 1. Token-2022 Transfer Hook
The mint is configured with a `TransferHook` extension that points to `dark_ritual_transfer_hook`. Every transfer — regardless of which wallet or program initiates it — triggers a CPI from Token-2022 into the hook program before the balance is moved. The hook can abort the transfer by returning an error. This is the enforcement mechanism: there is no path around it.

### 2. Instructions Sysvar
The hook program cannot call back into the top-level transaction; CPIs have their own instruction context. The Instructions sysvar (`sysvar::instructions`) exposes the *full list of top-level transaction instructions* to any program running within that transaction. The hook reads this sysvar to inspect the ceremony: it verifies that `dark_ritual_gate` with the `VerifyRitualShape` instruction tag is present before the transfer.

### 3. MemoTransfer Extension
The destination token account has the `MemoTransfer` extension enabled. This requires an SPL Memo instruction to appear immediately before the transfer instruction. The memo contains only a 64-character lowercase hex string: the `MemoCapsule` hash. No raw URLs. No raw buyer identity. Hash-only — the off-chain observer can verify the capsule independently.

### 4. CPI Guard Extension
The source token account has `CpiGuard` enabled. This Token-2022 extension prevents a program from draining the account on the user's behalf via CPI: if a program attempts a `Transfer` or `TransferChecked` on behalf of a user *inside a CPI*, it is rejected. Wallet-initiated transfers are allowed; program-initiated drains are not. This eliminates an entire class of malicious CPI patterns.

### 5. Ed25519 Precompile
The ritual transaction includes an `Ed25519Program` instruction (a Solana native precompile). The precompile verifies an Ed25519 signature over the `ritual_hash || permission_hash || expires_at_slot` payload. Precompile verification is executed by the Solana validator *before* any program code runs and cannot be faked. It cannot be called via CPI — the hook uses the Instructions sysvar to confirm the precompile instruction is present and was therefore natively verified.

### 6. Return Data
On success, the hook emits a 33-byte `HookVerdict` capsule via `set_return_data`:
- Byte 0: `0x01` (verdict = accepted)
- Bytes 1–32: `SHA256("dark_null_v1_hook_verdict" || mint_key || amount.to_le_bytes())`

This binds the verdict to the specific mint and amount. The caller (Token-2022 or an observer program) can read this return data via `get_return_data()`.

### 7. Address Lookup Tables (ALTs)
A ritual transfer ceremony includes: `ComputeBudget`, `MemoCapsule` (memo), `Ed25519Precompile`, `VerifyRitualShape` (ritual gate), and `Token2022Transfer` (with hook). That is 5 top-level instructions plus the hook accounts (extra PDA, Instructions sysvar, mint, source/dest accounts). Standard Solana v0 transactions with ALTs can fit all of this comfortably. Without ALTs, the account list would overflow the 32-account limit in complex ritual scenarios involving chaff, receipts, and nullifier banks.

## How It Works

```
Token-2022 Transfer
  └── Token-2022 calls dark_ritual_transfer_hook (Execute CPI)
        └── Hook reads accounts[5] = Instructions sysvar
              └── Scans all top-level tx instructions
                    ├── Finds dark_ritual_gate VerifyRitualShape instruction?
                    │     ├── NO  → Err(MissingRitualGate) — transfer aborted
                    │     └── YES → check ritual_type_byte == AgentSpendNoCustodyV1 (0x01)
                    │                ├── NO  → Err(WrongRitualType)
                    │                └── YES → emit HookVerdict return data → transfer proceeds
                    └── Forbidden program in tx? → Err(ForbiddenProgram)
```

The full ceremony (ordered instructions in the transaction):
1. `ComputeBudget` — allocate compute units
2. `SPL Memo` — MemoCapsule hash (64-char hex, MemoTransfer extension requirement)
3. `Ed25519Program` — native signature verification (permission braid)
4. `dark_ritual_gate` — `VerifyRitualShape` with ritual_type=0x01
5. `Token-2022 Transfer` — triggers hook → hook validates → transfer completes

## Three Devnet Scenarios

### Scenario 1: Bad Transfer (MissingRitualGate)
A caller submits a Token-2022 transfer without the `VerifyRitualShape` instruction. The hook scans all top-level instructions, finds no `dark_ritual_gate` call, and returns `ProgramError::Custom(0)` = `MissingRitualGate`. Token-2022 aborts the transfer. The token does not move.

Expected error: `MissingRitualGate (Custom:0)`

### Scenario 2: CPI Drain (CpiGuardExpected)
A malicious program attempts to drain the source token account by calling `Token-2022 TransferChecked` inside a CPI. The `CpiGuard` extension on the source account detects program-initiated transfer and rejects it. The Token-2022 runtime returns an error before the hook is even called.

Expected error: `CpiGuardExpected` (Token-2022 error)

### Scenario 3: Good Ritual Transfer (All Checks Pass)
A well-formed transaction with all five ceremony instructions passes every check:
- `CpiGuard`: wallet-initiated (not CPI) — allowed
- `MemoTransfer`: memo instruction present immediately before transfer — allowed
- Hook: finds `VerifyRitualShape` with correct ritual type — allowed
- Hook: emits `HookVerdict` return data with `0x01` prefix
- Token-2022: completes the transfer

## NOT_PRODUCTION Disclaimers

- **Devnet only**: all program IDs and accounts referenced here are devnet
- **Not ZK**: no zero-knowledge proofs, ritual hashes are transparent on-chain
- **External review pending**: independent security review has not been completed
- **mainnet_ready: false** — hardcoded in all evidence outputs
- **production_claim: false** — hardcoded in all evidence outputs
- **agent_had_private_key: false** — the demo agent uses a deterministic test key; no mainnet keys are generated or stored
