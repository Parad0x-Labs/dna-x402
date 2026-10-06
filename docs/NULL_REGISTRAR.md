# .null Domain Registrar

> ⚠️ **Legacy/illustrative.** This documents the v1 (NULL-priced, `IS_MAINNET_READY`) design.
> The mainnet registrar (retired; ran June–August 2026, records readable) was **v2** — **SOL-priced fee config via
> `SetConfig`, 0 during the pilot** — at `NXgQhepFpDCu935H1D4g34g59ZYbo1jR4tBCZWhV8Np`.
> The canonical v2 registrar source/spec is maintained privately and is available to reviewers on request.

**Program**: `programs/null_registrar`
**Status**: Pre-audit pilot — `IS_MAINNET_READY = false`

---

## What is .null?

`.null` is a sovereign domain namespace that lives entirely on Solana. No ICANN. No government. No registrar company that can suspend your domain for political reasons. A `.null` domain is a PDA on-chain; if Solana runs, your domain resolves.

It is the native namespace for the agentic web — Web0. Agents need identities that are machine-readable, cryptographically owned, and not subject to DNS seizure orders. `.null` fills that gap.

---

## Architecture

### NullDomain PDA

Seeds: `["null-domain", name[64]]`

Each registered name creates a PDA account holding:

| Field | Size | Description |
|---|---|---|
| `disc` | 1 | `0x4E` ('N') — account discriminant |
| `name` | 64 | Domain bytes, null-padded (e.g. `"parad0x\0\0..."`) |
| `owner` | 32 | Current owner Pubkey |
| `content_hash` | 32 | Arweave tx ID hash — what the name resolves to |
| `registered_at` | 8 | Unix timestamp of registration |
| `expires_at` | 8 | Unix timestamp of expiry (`0` = no expiry for founding domains) |
| `null_paid` | 8 | NULL tokens paid at registration (atomic units) |
| `bump` | 1 | PDA bump |

**Total: 154 bytes**

### RegistryConfig PDA

Seeds: `["null-registry"]`

Global singleton holding protocol parameters:

| Field | Size | Description |
|---|---|---|
| `disc` | 1 | `0x52` ('R') |
| `authority` | 32 | Squads multisig — the only key that can change fees |
| `registration_fee` | 8 | NULL tokens required to register (atomic); 0 (`DEFAULT_REGISTRATION_FEE`) |
| `null_mint` | 32 | The NULL token mint |
| `treasury` | 32 | ATA that receives registration fees |
| `total_registered` | 8 | All-time domain count (monotonic) |
| `bump` | 1 | PDA bump |

**Total: 114 bytes**

---

## Instructions

| Discriminant | Instruction | Who can call |
|---|---|---|
| `0x01` | `InitRegistry(fee, null_mint, treasury)` | Authority (one-time) |
| `0x02` | `Register(name, content_hash)` | Anyone with NULL balance |
| `0x03` | `UpdateContent(name, new_content_hash)` | Domain owner |
| `0x04` | `Transfer(name, new_owner)` | Domain owner |
| `0x05` | `Resolve(name)` | Anyone (read-only, emits log) |

### Register

1. Validates name: lowercase alphanumeric + hyphen, max 32 printable chars.
2. Checks the domain PDA does not already exist.
3. Reads `registration_fee` from `RegistryConfig`.
4. When `IS_MAINNET_READY = true`: executes SPL token transfer from caller ATA to treasury for `registration_fee` NULL.
5. Creates the `NullDomain` PDA via system program CPI.
6. Records timestamp, owner, content hash, fee paid.
7. Increments `total_registered` on the registry.

Founding domains (`expires_at = 0`) never expire. Time-bounded registrations for future name speculation mechanics will set a nonzero `expires_at`.

### UpdateContent

Owner calls this any time to point the domain at a new Arweave/IPFS hash. No fee. Instant. The old content hash is gone from active state (indexers retain history via transaction logs). The protocol does not and cannot censor content hashes.

### Transfer

Transfers ownership atomically. After transfer the old owner has zero on-chain authority. No escrow, no royalty, no middleman. Peer-to-peer domain trading at Solana speed.

### Resolve

Emits the current `content_hash` as a program log for indexers and RPC callers. Off-chain resolvers watch for `null-registrar: resolve pda=<X> content_hash=[...]` log lines.

---

## Registration Fee: 0

Registering a `.null` domain carries a 0% protocol fee: the registrant pays Solana rent for the domain account and nothing else. `DEFAULT_REGISTRATION_FEE` in `programs/null_registrar/src/lib.rs` is 0, the init scripts write `registration_fee = 0`, and the devnet `RegistryConfig` account of the 2026-10-06 deployment (`3RhyFd57nP7R1HysZC14M9xs9T6e1cJNrqBTAFnaF9mZ`) holds 0. The program never debits a fee in this build. Parad0x's only fee is the 0.05% x402 protocol fee on x402 payments.

The retired mainnet registrar (`NXgQhepF…`) had a config-set SOL fee, set to 0 during its pilot. That program is retired and its fee settings do not carry forward.

---

## Content Hash: Arweave / IPFS

The `content_hash` field is a 32-byte hash pointing to where the domain resolves. Intended usage:

- **Arweave**: SHA-256 of the Arweave transaction ID (permanent storage, never goes away)
- **IPFS**: CIDv1 SHA2-256 multihash (32 bytes of the digest)
- **Solana**: A program ID or PDA (resolve `.null` domain to a smart contract)

Because Arweave is permanent and Solana is permanent, a `.null` domain that resolves to Arweave content is truly unstoppable. No hosting company to serve a DMCA notice to. No DNS registry to seize.

---

## Name Rules

Valid names are 1-32 characters, using only:

- Lowercase letters `a-z`
- Digits `0-9`
- Hyphens `-`

The `.null` TLD is implicit; you register `parad0x`, not `parad0x.null`. Resolvers append the TLD.

---

## Cannot Be Seized

Traditional DNS depends on:
1. ICANN delegating the TLD to a registry
2. The registry delegating your domain to a registrar
3. The registrar keeping your domain active
4. The hosting company not suspending your IP

Any of those four parties can be pressured by a government. `.null` has none of them:

- The TLD is not delegated by ICANN — it is a Solana program
- The registry is a PDA owned by a Squads multisig, not a company
- There is no registrar — registration is a direct on-chain transaction
- Content points to Arweave, which is replicated across hundreds of nodes globally

The only way to seize a `.null` domain is to compromise the owner's private key, or convince the Squads multisig signers to upgrade the program and backdoor it. The latter requires >50% of signers and is publicly visible on-chain before it executes.

---

## IS_MAINNET_READY Flag

`IS_MAINNET_READY = false` in `src/lib.rs`.

When false:
- NULL token SPL transfer CPI is **skipped** (domain PDA is still created correctly)
- All name validation, ownership, and content hash logic runs normally
- Suitable for devnet testing and indexer integration

The registration fee stays 0 under the fee rule above, so no NULL fee collection path is planned. `IS_MAINNET_READY` gates only the dormant SPL transfer code path, which moves nothing while `registration_fee` is 0.

---

## Program Layout

```
programs/null_registrar/
  Cargo.toml
  src/
    lib.rs           -- entrypoint, IS_MAINNET_READY, 18 unit tests
    state.rs         -- NullDomain + RegistryConfig pack/unpack
    instruction.rs   -- RegistrarInstruction unpack + validate_name
    error.rs         -- RegistrarError (0x7001-0x7005)
    processor.rs     -- instruction dispatch + PDA logic
```

---

## Error Codes

| Code | Name | Meaning |
|---|---|---|
| `0x7001` | `NameAlreadyRegistered` | Domain PDA already exists |
| `0x7002` | `NameTooLong` | Name exceeds 32 printable characters |
| `0x7003` | `InsufficientNullBalance` | Caller NULL balance < registration fee |
| `0x7004` | `NotOwner` | Caller is not the current domain owner |
| `0x7005` | `InvalidName` | Name contains disallowed characters |
