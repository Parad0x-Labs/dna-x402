# DARK NULL — Transaction Ritual VM

## What It Is

The **Transaction Ritual VM** is a Solana-native primitive that verifies the _entire choreography_ of an AI-money action at the transaction level — not just whether one instruction succeeds, but whether the full sequence of instructions is structurally correct, properly ordered, and free of forbidden operations.

It operates on capabilities that are unique to Solana's execution model:

| Solana Capability | Ritual VM Layer |
|---|---|
| Instructions sysvar | Introspect all tx instructions from inside a program |
| Transaction grammar | Enforce step ordering (PermissionProof before SpendShadow) |
| Account meta shape | k-anonymity across the account lock set |
| Return data | Emit a 33-byte proof capsule after verification |
| CPI manifest | Declare and enforce every cross-program invocation |
| Account lock scoring | Privacy-score the writable/readonly account split |
| Rent lifecycle | Measure chaff economic efficiency via rent delta |

---

## Architecture

```
Transaction (Solana)
│
├── ComputeBudget         (optional)
├── IntentCapsule         → declares ritual intent to dark_ritual_gate
├── PermissionProof       → proves agent permission note is valid
├── SpendShadow           → submits shadow bundle; PermissionProof must precede this
├── ReceiptSoul           → issues BurnAfterRead receipt nullifier
├── NullifierInsert       → inserts spend nullifier into sharded bank
└── ChaffMaintenance      → optional rent-reclaim chaff (makes tx profitable)

                    ↓ validated by
          dark_ritual_gate program
                    ↓ emits return data
          [verdict:1][ritual_hash:32]  (33 bytes)
```

The `dark_ritual_gate` program calls `set_return_data` with a 33-byte proof capsule:
- Byte 0: `0x01` = Accepted, `0x00` = Rejected
- Bytes 1–32: `SHA256("dark_null_v1_ritual" || all_input_hashes || max_spend_le8)`

---

## Components

### `crates/ritual-grammar`

Core validation types and logic. Defines:
- **`RitualType`** — `AgentSpendNoCustodyV1`, `ReceiptSoulRedeemV1`, `AlphaCapsuleCommitV1`, `SessionSettlementV1`, `ChaffMaintenanceV1`
- **`RitualGrammar`** — ordered step list with required/optional flags; names the permission and spend steps
- **`validate_ritual(grammar, observation)`** — returns `shape_hash` or `RitualViolation`
- **`RitualViolation`** — `MissingRequiredStep`, `ForbiddenProgram`, `PermissionMustPrecedeSpend`, `WithdrawInstructionForbidden`, `ShapeHashMismatch`
- **`compute_shape_hash(steps)`** — `SHA256("dark_null_v1_ritual_shape" || step_names || data_hashes)`

### `crates/ritual-compiler`

Offline ritual plan compiler. Takes pre-hashed inputs and produces:
- **`RitualPlan`** — ordered `InstructionPlan` list, `expected_shape_hash`, `expected_ritual_hash`, human summary
- **`RitualProofCapsule`** — via `ritual-proof-capsule`
- **`compile_ritual(input)`** — Errors if `withdraw_allowed = true`
- **`program_hash(role)`** — `SHA256("dark_null_v1_program_role" || role_bytes)` — canonical placeholder for offline compilation

### `programs/dark_ritual_gate`

On-chain Solana program (BPF). Handles two instructions:
- `0x00` VerifyRitualShape — validates tx grammar, emits return data
- `0x01` EchoProof — echoes a ritual hash back as return data

Return data: `[verdict_byte:1][ritual_hash:32]` = 33 bytes.

Features:
- `no-entrypoint` feature for unit testing without BPF runtime
- `crate-type = ["cdylib", "lib"]` for both program and test builds

### `crates/ritual-proof-capsule`

The proof object carried as return data. Fields:
- `ritual_type`, `ritual_hash`, `shape_hash`
- `permission_hash`, `receipt_hash`, `nullifier_hash`, `no_custody_hash`, `rent_delta_hash`
- `verdict: RitualVerdict` — `Accepted | Rejected { reason } | Pending`

Functions:
- `capsule_hash(capsule)` — binding commitment over all fields
- `encode_capsule / decode_capsule` — u32-LE length prefix + JSON bytes
- `redacted_display(capsule)` — public-safe view: only ritual_hash, shape_hash, verdict

### `crates/ritual-shape-market`

k-anonymity tracker for transaction shapes.
- **`ShapeMarket`** — append-only observations list
- **`k_shape(hash)`** — how many transactions share this shape
- **`report(hash)`** — returns `ShapeRiskLevel`: `Safe` (k ≥ 5) / `LowAnonymity` (2 ≤ k < 5) / `Doxxed` (k ≤ 1)
- **`compute_class_hash(ritual_type, step_names)`** — canonical shape class identifier

### `crates/cpi-firewall`

CPI manifest validation.
- **`CpiManifest`** — declares allowed CPIs, forbidden program hashes, effect hash, max depth
- **`CpiPolicy`** — `NoCpiAllowed | AllowedOnly(Vec<AllowedCpi>) | AllowedWithManifest { manifest_hash }`
- **`validate_cpi_manifest(manifest, policy)`** — checks forbidden/allowed sets, manifest hash parity
- **`bind_manifest_to_ritual(manifest_hash, ritual_hash)`** — `SHA256("dark_null_v1_cpi_bind" || ...)`
- **`validate_token_transfer(manifest, receiver_hash, mint_hash)`** — SPL token CPI binding

### `crates/account-lock-alchemy`

Account lock privacy scoring.
- **`AccountLockPlan`** — writable set, readonly set, decoy readonly set, plan_hash
- **`WritableHeat`** — per-account recent write count and heat score (0.0–1.0)
- **`score_lock_plan(plan, heats, privacy)`** — composite `LockAlchemyScore`:
  - `overall = (1 - fee_heat) × 0.3 + (1 - fingerprint_uniqueness) × 0.3 + shape_pool × 0.2 + parallelism × 0.2`
  - recommendation: `"safe"` / `"risky: unique fingerprint"` / `"risky: hot accounts"`
- **`plan_is_doxxed(privacy)`** — true if `uniqueness_ratio > 0.8`
- **`should_rollover_shard(plan, heats)`** — true if any writable account has `heat_score > 0.7`

### `crates/rent-delta-proof`

Rent economics for chaff efficiency.
- **`RentAction`** — `CreateAccount { lamports }` / `CloseAccount { lamports }` / `Realloc { delta_bytes, lamports_delta }`
- **`compute_rent_delta(actions)`** — `rent_locked`, `rent_reclaimed`, `net_rent_cost`, `chaff_reward = min(reclaimed, locked)`
- **`summarize_rent_delta(proof, redact_owners)`** — `net_label`: `"profitable"` / `"self-funding"` / `"net cost"`
- `summary_hash = SHA256("dark_null_v1_rent_delta" || net_cost_le8 || chaff_reward_le8)`

---

## Shape Hash Formula

```
shape_hash = SHA256(
    "dark_null_v1_ritual_shape"
    || step0_name_bytes || step0_instruction_data_hash
    || step1_name_bytes || step1_instruction_data_hash
    || ...
)
```

This hash is the publicly observable fingerprint of a ritual. Two transactions with the same shape hash are structurally indistinguishable from each other — the basis for k-anonymity.

---

## Ritual Hash Formula

```
ritual_hash = SHA256(
    "dark_null_v1_ritual"
    || permission_hash
    || spend_hash
    || shadow_bundle_hash
    || receipt_soul_hash
    || settlement_root
    || no_custody_hash
    || max_spend_lamports_le8
)
```

This is the binding commitment over all primitive inputs. The `dark_ritual_gate` program includes it in return data so the caller can verify the program processed the same inputs.

---

## What Remains Mock / Devnet Only

| Layer | Status |
|---|---|
| `dark_ritual_gate` BPF | Compilable to BPF; deploy requires `cargo build-sbf` + `solana program deploy` |
| Instructions sysvar introspection | Correct pattern coded; live test requires deployed program |
| Poseidon hash parity | SHA-256 domain-separated as proxy; BPF Poseidon syscall swap is a one-line change |
| ZK proof of ritual | Return data capsule is a commitment; full Groth16 binding requires `dark-proof-gate-lite` integration |

---

## Running the Demo

```bash
# Unit tests (all offline, no devnet)
cargo test --workspace

# Demo binary — writes dist/ritual-vm/RITUAL_VM_DEMO.json
cargo run -p ritual-vm-demo --bin ritual_vm_demo

# Attempt BPF compilation of dark_ritual_gate
cargo build-sbf --manifest-path programs/dark_ritual_gate/Cargo.toml
```

Evidence artifacts:
- `dist/ritual-vm/RITUAL_VM_DEMO.json` — full structured proof
- `docs/RITUAL_VM_PUBLIC_DEMO.md` — ELI5 narrative

> NOT_PRODUCTION. Devnet only. No audit. No mainnet keys. `mainnet_ready = false`.
