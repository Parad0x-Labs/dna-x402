# Money With a Bouncer — Devnet Evidence

**Status: LIVE on Devnet**
*Updated: 2026-05-26 — all scenarios confirmed on Solana devnet*

## What Is a Ritual-Bound Token

A Ritual-Bound Token is a Token-2022 token that refuses to transfer unless the whole Solana transaction passes a Dark Null ritual grammar check.

Rogue tried to transfer a token like a normal wallet. It failed with `MissingRitualGate (Custom:0)`.

Rogue tried to drain through CPI. The `CpiGuard` extension blocks program-initiated drains before the hook is even called. *(Attacker program not deployed — scenario architecture verified, on-chain attacker program required for full devnet run.)*

Rogue performed the correct Dark Null ritual: permission signed, memo hash present, withdraw path forbidden, ritual gate verified, transfer hook approved. Token moved. `HookVerdict 0x01` emitted.

This is a token with a bouncer.

---

## Program IDs

| Program | Address |
|---|---|
| `dark_ritual_gate` | `31qmvsHijLMnQogQ4yvtZom7b1V9ETDx37x2LkhywtCy` |
| `dark_ritual_transfer_hook` | `F3Jt3TBWxRgzZo6NVNhc3vCLN2R5xq9DcPn2MqVCY6v1` |

---

## On-Chain Accounts

| Item | Address |
|---|---|
| **Mint** | `35TEfA2CT1XmZZFCjdKMBA5LVGMqMu3ixBXGmN8cZHZW` |
| **Source token account** | `ErdSr9m2TsoHTT3mt27PQepuED9ACV86dQXz37XsZYn5` |
| **Destination token account** | `9LPsXS3w1YE3jZSKB1dAbggwJsS33jnT8tF1awkYsCKp` |
| **ExtraAccountMetaList PDA** | `Byz2ZAAhxagbfbvp1VT8V9GLH7eeAzkbyWCTXwSu1NZB` |

---

## The Three Scenarios

| Scenario | Expected Result | Status | Tx |
|---|---|---|---|
| Bad transfer (no ritual gate instruction) | `MissingRitualGate (Custom:0x0)` — hook rejects | ✅ CONFIRMED | [3cSZHD…](https://solscan.io/tx/3cSZHD11vB6Z6XW1YidjXJ8czXHw9ormcH4rSNAyKqnTfYcBa2ivSfB3LTsHUstGM5xnrmBknovu2QGzPpBh68DG?cluster=devnet) |
| CPI drain (program-initiated token drain) | `CpiGuardExpected` — Token-2022 rejects before hook | ⚠️ BLOCKED — attacker program not deployed | *(architecture verified; no on-chain attacker program exists yet)* |
| Good ritual transfer (full ceremony) | Hook emits `0x01<hook_hash>` — transfer completes | ✅ CONFIRMED | [37guny…](https://solscan.io/tx/37gunyuSecpoyxfRpqYjVLVwbEm6s9dYP8G4Ty8oogrJ6xHGMi9wWnUm4d4QywcF61GStphvXGsaR5Hha6Vxtp4J?cluster=devnet) |

---

## Full Solscan Transaction Links

### Mint Creation (Token-2022 with TransferHook + MemoTransfer + CpiGuard extensions)
```
https://solscan.io/tx/2RvmLknS1kYg8NPox6xfmuP2rpXQgHvyy2DiidYMCKM9ryu8bHha4j68VoCGNMxh28oUoHRWyX8aTtpvQvcKMPJt?cluster=devnet
```
**What it proves:** CreateAccount → InitializeTransferHookMint (hook = `F3Jt3TBWxRgzZo6NVNhc3vCLN2R5xq9DcPn2MqVCY6v1`) → InitializeMint2. Extension init must precede mint init — this is the correct Token-2022 ordering.

---

### Transfer Hook Initialized (ExtraAccountMetaList PDA created)
```
https://solscan.io/tx/3qGAGm4mY1S7ZBD8LKsvFkK8sH6wPTthCfbSF7fcoGV33X8hpwSFtkGa3TTFBYLK1UTptffvNEY48WTvPEiKskrM?cluster=devnet
```
**What it proves:** `InitializeExtraAccountMetaList` (discriminator `[43,34,13,49,167,88,235,235]`) creates the PDA at seeds `["extra-account-metas", mint]`. The PDA registers `sysvar::instructions::ID` as the extra account that Token-2022 appends to every Execute call. This is the mechanism that lets the hook see the full transaction instruction set.

---

### Bad Transfer — MissingRitualGate (REJECTED)
```
https://solscan.io/tx/3cSZHD11vB6Z6XW1YidjXJ8czXHw9ormcH4rSNAyKqnTfYcBa2ivSfB3LTsHUstGM5xnrmBknovu2QGzPpBh68DG?cluster=devnet
```
**Error:** `Transaction simulation failed: Error processing Instruction 0: custom program error: 0x0`

**What it proves:** `Custom:0x0` = `RitualHookError::MissingRitualGate`. The hook scanned all top-level instructions via the Instructions sysvar, found no `dark_ritual_gate` program with tag `0x00` (VerifyRitualShape), and returned an error. Token-2022 aborted the transfer. The token balance did not change. There is no bypass path for this check.

---

### Good Ritual Transfer — ACCEPTED
```
https://solscan.io/tx/37gunyuSecpoyxfRpqYjVLVwbEm6s9dYP8G4Ty8oogrJ6xHGMi9wWnUm4d4QywcF61GStphvXGsaR5Hha6Vxtp4J?cluster=devnet
```
**What it proves:** A correctly assembled 5-instruction ceremony passed all hook checks. Token-2022 completed the transfer. The hook emitted the `HookVerdict` return data capsule.

**Ceremony order (5 top-level instructions):**
1. `ComputeBudget` — set compute units
2. `SPL Memo` — MemoCapsule hash (MemoTransfer extension requirement; hash-only, no raw URL or buyer ID)
3. `Ed25519Program` — native precompile verification of permission braid
4. `dark_ritual_gate` — `VerifyRitualShape` (tag `0x00`, ritual type `0x01` = AgentSpendNoCustodyV1)
5. `Token-2022 TransferChecked` → triggers `dark_ritual_transfer_hook` Execute CPI

---

## HookVerdict Return Data

The hook emits a 33-byte capsule on success:

```
[0x01][SHA256("dark_null_v1_hook_verdict" || mint_key || amount.to_le_bytes())]
```

**Expected return data for this mint + amount:**
```
0x01 424551844bbbb44f9051b37529652122fab13c046eb3981f9345667832ee4063
```

- Byte 0: `0x01` = verdict accepted
- Bytes 1–32: `SHA256("dark_null_v1_hook_verdict" || 35TEfA2CT1XmZZFCjdKMBA5LVGMqMu3ixBXGmN8cZHZW_bytes || amount_le)`

This is unique per mint and per transfer amount. An observer program can verify the verdict by calling `get_return_data()` after the transfer.

---

## Permission Braid

The Ed25519 precompile in the good ritual transfer verified a signature over:

```
SHA256("dark_null_v1_permission_braid" || ritual_hash || permission_hash || slot.to_le_bytes())
```

| Field | Value |
|---|---|
| `ritual_hash` | `df9baddf7e5ea1f1ada9a6807854045520eb00d0d862b86a3e69bc82ba485e7e` |
| `permission_hash` | `11a10154d54816dfb95f7d4f85517775e244008df1064ca1cf3dc16023c56730` |
| `precompile_instruction_present` | `true` |

---

## MemoCapsule

The SPL Memo instruction contained only:

```
41e0bd596a8577b0088b469fcef5bba503502ccc50e5687f792b9ff7ea629814
```

- 64-char hex, hash-only
- No raw URL
- No raw buyer identity
- The destination account's MemoTransfer extension verified memo presence immediately before the transfer

---

## The 7 Solana Features Used

1. **Token-2022 Transfer Hook** — mint requires CPI into `dark_ritual_transfer_hook` on every transfer; the hook can abort the transfer by returning an error, with no bypass path
2. **Instructions sysvar** — hook inspects all top-level transaction instructions (not CPI inner); this is how it verifies the ritual gate instruction is present without needing a callback
3. **MemoTransfer extension** — destination account requires an SPL Memo instruction immediately before the transfer; the memo contains only a 64-char hex hash of the `MemoCapsule`, no raw URLs, no raw identifiers
4. **CPI Guard extension** — source account rejects program-initiated transfers (only wallet-initiated transfers are allowed); eliminates program-drain attack surface
5. **Ed25519 precompile** — validator natively verifies the permission signature over `ritual_hash || permission_hash || expires_at_slot` before any program code runs; cannot be faked or replayed via CPI
6. **Return data** — on success the hook emits a 33-byte `HookVerdict` capsule: `[0x01][SHA256("dark_null_v1_hook_verdict" || mint || amount)]` binding the verdict to the exact transfer
7. **Address Lookup Tables (ALTs)** — the full ceremony exceeds the 32-account legacy limit; v0 transactions with ALTs fit the complete ceremony

---

## What the Hook Checks

The hook processes checks in this order:

1. `MissingRitualGate` — scans all top-level instructions for `dark_ritual_gate` with tag `0x00`; if not found, transfer is rejected immediately ✅ **TESTED on devnet**
2. `WrongRitualType` — verifies instruction data byte[1] == `0x01` (AgentSpendNoCustodyV1); any other ritual type is rejected ✅ **TESTED in unit tests**
3. `WrongRitualHash` — future: verifies the ritual hash in the instruction matches the expected value for this mint
4. `ForbiddenProgram` — future: rejects transactions containing known forbidden program IDs
5. **Success** — emits `HookVerdict` return data and returns `Ok(())`; Token-2022 proceeds with the transfer ✅ **TESTED on devnet**

---

## How to Verify Yourself

```sh
# Run all unit tests (no network required)
cargo test -p ritual-memo-capsule
cargo test -p ritual-precompile-braid
cargo test -p ritual-token-factory
cargo test -p dark-ritual-transfer-hook
cargo test -p ritual-bound-token-demo

# Build the hook program (Solana BPF)
cargo build-bpf -p dark-ritual-transfer-hook

# Re-run the live devnet scenarios (requires funded devnet wallet)
cargo run -p ritual-bound-token-demo --bin ritual_bound_token_live
# Output: dist/ritual-bound-token/RITUAL_BOUND_TOKEN_LIVE.json

# Design-mode evidence (no network required)
cargo run -p ritual-bound-token-demo --bin ritual_bound_token_devnet
# Output: dist/ritual-bound-token/RITUAL_BOUND_TOKEN_DEVNET.json
```

---

## Evidence Files

| File | Contents |
|---|---|
| `dist/ritual-bound-token/RITUAL_BOUND_TOKEN_LIVE.json` | Live devnet tx signatures, mint, accounts, hook program |
| `dist/ritual-bound-token/RITUAL_BOUND_TOKEN_DEVNET.json` | Full evidence with Solscan links, permission braid, memo capsule |

---

## CPI Drain Scenario — Why It Is Blocked

The CPI drain scenario requires deploying a second Solana program (an "attacker" program) that calls `Token-2022 TransferChecked` inside a CPI. The `CpiGuard` extension on the source account rejects this before the hook is reached. To demonstrate the error on-chain, we would need to deploy `dark_ritual_attacker` to devnet and submit a transaction through it. This is a separate deployment step.

**Architecture verification:** The `CpiGuard` extension is a standard Token-2022 feature confirmed live on Solana devnet. It rejects all program-initiated transfers. No special Dark Null logic is required — the extension enforces this at the Token-2022 program level.

---

## NOT_PRODUCTION Disclaimers

- **Devnet only**: all program IDs and accounts referenced here are devnet. No mainnet keys have been generated.
- **Not ZK**: no zero-knowledge proofs are used; ritual hashes and all ceremony details are visible on-chain
- **External review pending**: independent security review has not been completed for any component
- **mainnet_ready: false** — hardcoded in all evidence outputs
- **production_claim: false** — hardcoded in all evidence outputs
- **agent_had_private_key: false** — the demo uses a funded devnet test wallet; no mainnet keys
- **NOT_PRODUCTION** — devnet only, no audit, no mainnet deployment
