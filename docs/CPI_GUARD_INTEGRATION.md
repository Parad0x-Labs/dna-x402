# CPI Guard Integration

## What CPI Guard Does

CPI Guard is a Token-2022 extension that locks a token account against drainage
via cross-program invocation (CPI) from any program except the Token Extensions
Program itself (the `spl-token-2022` program).

Without CPI Guard, a malicious or compromised intermediate program can call
`spl_token_2022::instruction::transfer` inside a CPI chain and drain a token
account your program created. The attack vector:

    Attacker contract
      → CPI → Your vault program
          → CPI → Token Extensions Program (transfer out of vault)

With CPI Guard enabled on the vault token account, step 3 is rejected at the
Token Extensions Program level unless the immediate caller is the account owner
acting directly (not through CPI). It is a runtime-level reentrancy guard with
zero performance overhead.

This is distinct from reentrancy locks you might implement yourself. It operates
at the token program layer, not at your program layer, so it cannot be bypassed
by any on-chain manipulation.

---

## Where to Enable It in Our Stack

### 1. `dark_shielded_pool` vault token account

**Current state:** The pool vault (`pool_vault_info`) is a plain SOL lamport
account — not a Token-2022 token account. CPI Guard applies to SPL token
accounts only. When the pool is migrated to hold USDC or another SPL token
(the planned Token-2022 migration), enable CPI Guard on the vault token account
immediately after creation in `process_init_pool`.

File: `programs/dark_shielded_pool/src/processor.rs`, inside `process_init_pool`

### 2. `dark_secp256r1_vault` float accounts

Any token accounts created to hold float balances (fee escrow, collateral) during
the Token-2022 migration should have CPI Guard enabled at account creation time.

### 3. `receipt_anchor` fee collection accounts

If `receipt_anchor` ever creates or controls SPL token accounts for fee
accumulation, enable CPI Guard on those accounts at initialization.

---

## How to Enable on a Token-2022 Account

Add this block **after** the `create_account` + `initialize_account3` calls for
the vault token account. The authority must be a signer.

```rust
// Enable CPI Guard on vault token account after creation.
// This prevents any program other than Token-2022 from draining it via CPI.
// Cost: one instruction, zero performance impact.
// Audit significance: auditors flag missing CPI Guard as a medium finding.
// See docs/CPI_GUARD_INTEGRATION.md
invoke(
    &spl_token_2022::instruction::enable_cpi_guard(
        &spl_token_2022::id(),
        vault_token_account.key,
        authority.key,
        &[],   // no multisig signers
    )?,
    &[vault_token_account.clone(), authority.clone()],
)?;
```

The `enable_cpi_guard` instruction requires:
- `token_account` — the Token-2022 account to protect (writable)
- `owner` — the account's current authority (signer)
- `signers` — multisig co-signers, empty slice for single-authority accounts

The `invoke` vs `invoke_signed` choice depends on whether your authority is a
PDA. For a PDA authority use `invoke_signed` with the appropriate seeds.

### Cargo dependency

Add to the program's `Cargo.toml`:

```toml
[dependencies]
spl-token-2022 = { version = "1", features = ["no-entrypoint"] }
```

---

## Why It Matters for Security Audits

Security auditors working to the Token-2022 extension checklist treat CPI Guard
as a near-zero-cost hardening step. Its absence on vault accounts is reported as
a medium-severity finding in most DeFi audit frameworks (Sec3, OtterSec, Neodyme
all flag it). Its presence is a positive checkmark.

Specific audit language you will see:

> "Vault token account does not have CPI Guard enabled. An exploitable CPI
> reentrancy path exists if any upstream program is compromised."

Enabling it converts that finding to:

> "Vault token account has CPI Guard enabled. CPI-based drainage is mitigated
> at the token program layer."

This is a structural hardening that costs nothing and survives program upgrades
because it is stored in the token account's extension data, not in your program.

---

## Cost

- **Compute units:** approximately 2,000 CU for the `enable_cpi_guard`
  instruction — negligible, paid once at vault initialization
- **Lamports:** zero additional rent (the extension slot is pre-allocated when
  `initialize_account3` is called with CPI Guard in the extension list, or it
  can be added to an existing account via `reallocate`)
- **Code complexity:** one `invoke` call
- **Ongoing overhead:** none — the guard is checked by the Token Extensions
  Program, not your program

---

## Enabling on an Existing Token-2022 Account

If the vault token account already exists without CPI Guard, you need to
`reallocate` it to make room for the extension, then enable it:

```rust
// Step 1: reallocate to add CPI Guard extension space
invoke(
    &spl_token_2022::instruction::reallocate(
        &spl_token_2022::id(),
        vault_token_account.key,
        payer.key,
        authority.key,
        &[],
        &[spl_token_2022::extension::ExtensionType::CpiGuard],
    )?,
    &[vault_token_account.clone(), payer.clone(), system_program.clone(), authority.clone()],
)?;

// Step 2: enable CPI Guard
invoke(
    &spl_token_2022::instruction::enable_cpi_guard(
        &spl_token_2022::id(),
        vault_token_account.key,
        authority.key,
        &[],
    )?,
    &[vault_token_account.clone(), authority.clone()],
)?;
```

---

## Migration Checklist

- [ ] `dark_shielded_pool`: complete Token-2022 vault migration
- [ ] `dark_shielded_pool`: add `enable_cpi_guard` call in `process_init_pool` after vault token account creation
- [ ] `dark_secp256r1_vault`: audit all token accounts created in `processor.rs`; add `enable_cpi_guard` to each initialization path
- [ ] `receipt_anchor`: audit fee collection token accounts; add `enable_cpi_guard` where applicable
- [ ] Update `Cargo.toml` for each affected program to depend on `spl-token-2022`
- [ ] Add integration test: attempt CPI transfer from non-owner program, assert error `CpiGuardViolation`
