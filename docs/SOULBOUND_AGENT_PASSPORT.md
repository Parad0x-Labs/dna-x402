# Soulbound Agent Passport — Design Spec v0.1

> Program: `agent_credential_mint`
> IS_MAINNET_READY: false (devnet scaffold)
> Depends on: `dark_secp256r1_vault`, `dark_secp256k1_auth`

---

## 1. Problem

`dark_secp256r1_vault` and `dark_secp256k1_auth` bind biometric/ETH identity to Solana
PDAs. These are program data accounts, not token accounts. There is no token-level
enforcement of identity: an agent's "passport" exists as a PDA record with no
composable on-chain representation that other programs can inspect, verify, or revoke.

Two gaps this creates:

1. No standard revocation path. Freezing a custom account requires ad-hoc protocol
   logic in every consumer program.
2. No composable identity primitive. SPL Token-2022 consumers (DeFi, hooks, gating)
   cannot natively ask "does this wallet hold a valid passport?"

---

## 2. Solution: Soulbound Token-2022 Credential

When an agent registers a Dark Passport (secp256r1 OR secp256k1 binding), the protocol
**additionally mints exactly 1 soulbound credential token** to the agent's wallet.

### Token-2022 Extensions Used

| Extension | Why |
|---|---|
| `NonTransferable` | Token cannot be sent to any address — it is bound to the issuing wallet |
| `PermanentDelegate` | Protocol authority PDA retains permanent delegate rights for burn (revocation) |
| `MetadataPointer` + `TokenMetadata` | Stores agent identity fields on-chain without a separate Metaplex metadata account |

### On-Chain Metadata Fields

```
agent_id        — SHA-256(agent_pubkey || device_pubkey)  [32 bytes hex]
device_pubkey   — compressed secp256r1 (P-256) or secp256k1 pubkey  [33 bytes hex]
binding_type    — "secp256r1" | "secp256k1"
issued_at       — Unix timestamp at issuance (slot clock)
passport_version — "1"
```

---

## 3. Issuance Flow

```
Agent                   dark_secp256r1_vault /         agent_credential_mint
                        dark_secp256k1_auth
  │                            │                               │
  │── RegisterPasskeyVault ───►│                               │
  │   (secp256r1 precompile)   │                               │
  │                            │── CPI: IssueCredential ──────►│
  │                            │   (agent_pubkey,              │
  │                            │    device_pubkey,             │
  │                            │    binding_type)              │
  │                            │                               │── Mint 1 token
  │                            │                               │   NonTransferable
  │                            │                               │   PermanentDelegate
  │                            │                               │   = protocol_authority
  │◄───────────────────────────│◄──────────────────────────────│
  │   PDA created +            │                               │
  │   credential token in      │                               │
  │   agent wallet             │                               │
```

The same CPI path applies for `dark_secp256k1_auth` (ETH/secp256k1 binding).

### Issuance Fee

- First issuance: **0.01 USDC** paid via x402 payment header before the transaction.
- Re-issuance (device upgrade): **0.001 USDC** (burn-and-reissue, same agent identity).
- Payment receipt is included in the instruction data and verified on-chain (devnet: skipped).
- Revenue: every new agent + every hardware upgrade generates recurring protocol revenue.

---

## 4. Revocation via Permanent Delegate

### Why Permanent Delegate beats Freeze

| Mechanism | Token state after action | Agent can re-use? | Clean? |
|---|---|---|---|
| Freeze | Exists, frozen (unspendable) | No — confusing state | No — stale record |
| Burn via PermanentDelegate | **Gone** | Must re-register | Yes — clean slate |

Freezing leaves a token in an ambiguous state: it still "exists" in the wallet and may
confuse indexers, dashboards, and downstream programs. Permanent Delegate burn is
unambiguous — the credential is gone, the agent's identity is revoked, and they must
re-register with new hardware.

### Credit Clawback Mechanism

When a compromised agent holds unspent x402 credits:

1. Protocol flags the agent (compromised device / policy violation / court order).
2. Protocol calls `RevokeCredential(agent_pubkey)` — burns the credential token via
   Permanent Delegate without requiring the agent's signature.
3. The credential token is gone. Any x402 payment handler that gate-checks credential
   balance will now reject the agent's payments.
4. Remaining credits are frozen at the x402 layer by the same authority.

The Permanent Delegate key is a PDA of `agent_credential_mint` seeded by
`[b"protocol_authority"]` — it has no private key, only a program-signed PDA that the
`agent_credential_mint` program controls via `invoke_signed`.

---

## 5. Burn-and-Reissue: Device Upgrade

```
UpgradeCredential(old_device_pubkey, new_device_pubkey)
  1. Verify caller is the agent (wallet signature)
  2. Verify old_device_pubkey matches the existing CredentialRecord PDA
  3. Burn old credential token via PermanentDelegate CPI
  4. Mint new credential token with updated metadata (new device_pubkey, new issued_at)
  5. Update CredentialRecord PDA
  6. Charge 0.001 USDC re-issuance fee via x402
```

Same `agent_id` is preserved across upgrades — the agent's identity continuity is
maintained even when hardware changes.

---

## 6. Instruction Set

### 0x01 — IssueCredential

```
data layout: [0x01][agent_pubkey[32]][device_pubkey[33]][binding_type[1]]
             [x402_receipt_hash[32]]

binding_type: 0x01 = secp256r1 (P-256 passkey)
              0x02 = secp256k1 (ETH/MetaMask)

Accounts:
  [0] agent_wallet          — signer, writable (receives token)
  [1] credential_mint       — writable (new Token-2022 mint, unique per agent)
  [2] agent_token_account   — writable (ATA for credential_mint)
  [3] credential_record_pda — writable (seeds: [b"cred", agent_pubkey])
  [4] protocol_authority    — PDA (seeds: [b"protocol_authority"]) — PermanentDelegate
  [5] system_program
  [6] token_2022_program
  [7] associated_token_program
  [8] rent sysvar

Actions:
  - Derive credential_record_pda, check it does not already exist
  - Create Token-2022 mint with NonTransferable + PermanentDelegate extensions
  - Initialize TokenMetadata with agent_id, device_pubkey, binding_type, issued_at
  - Mint 1 token to agent_token_account
  - Write CredentialRecord PDA
  - IS_MAINNET_READY = false: skip x402 fee check, skip CPI mint (record only)
```

### 0x02 — RevokeCredential

```
data layout: [0x02][agent_pubkey[32]]

Accounts:
  [0] protocol_authority_signer — must be protocol_authority PDA or admin keypair
  [1] agent_token_account       — writable (burn target)
  [2] credential_mint           — writable
  [3] credential_record_pda     — writable (will be closed / zeroed)
  [4] token_2022_program

Actions:
  - Verify caller == protocol_authority PDA
  - Burn 1 token via PermanentDelegate (invoke_signed with protocol_authority seeds)
  - Zero out CredentialRecord PDA (mark as revoked, do NOT close — keep revocation log)
  - IS_MAINNET_READY = false: set revoked flag in PDA, skip token burn CPI
```

### 0x03 — UpgradeCredential

```
data layout: [0x03][old_device_pubkey[33]][new_device_pubkey[33]]
             [x402_receipt_hash[32]]

Accounts:
  [0] agent_wallet            — signer (must be the registered agent)
  [1] old_agent_token_account — writable (burn)
  [2] credential_mint         — writable
  [3] new_agent_token_account — writable (mint target, same wallet / same mint)
  [4] credential_record_pda   — writable (update device_pubkey)
  [5] protocol_authority      — PDA
  [6] token_2022_program
  [7] system_program

Actions:
  - Verify agent_wallet == credential_record_pda.agent_pubkey
  - Burn old credential token via PermanentDelegate
  - Update credential_record_pda.device_pubkey, .issued_at
  - Remint 1 token to new_agent_token_account
  - Update TokenMetadata (device_pubkey, issued_at fields)
  - IS_MAINNET_READY = false: update PDA only, skip token CPIs
```

---

## 7. On-Chain State

### CredentialRecord PDA

```
Seeds: [b"cred", agent_pubkey[32]]
Size: 155 bytes

Offset  Len  Field
     0    1  disc = 0xCR (0x43 0x52)
     1   32  agent_pubkey
    33   33  device_pubkey         (compressed, 33 bytes)
    66    1  binding_type          (0x01 secp256r1 | 0x02 secp256k1)
    67   32  credential_mint       (Token-2022 mint address)
    99    8  issued_at_slot        (u64 le)
   107    8  issued_at_unix        (u64 le)
   115    1  passport_version      (u8, currently 1)
   116   32  agent_id_hash         (SHA-256 of agent_pubkey || device_pubkey)
   148    1  revoked               (0x00 = active, 0x01 = revoked)
   149    1  binding_version       (u8 — for future key rotation)
   150    5  _reserved             (zero-padded)
```

Total: 155 bytes

---

## 8. Integration with Existing Programs

### dark_secp256r1_vault — after RegisterPasskeyVault

```rust
// In processor.rs, after writing VaultRecord:
#[cfg(feature = "mainnet")]
{
    let credential_mint_program = AGENT_CREDENTIAL_MINT_PROGRAM_ID.parse().unwrap();
    let issue_ix = build_issue_credential_ix(
        agent_pubkey,
        p256_compressed, // 33-byte device_pubkey
        BindingType::Secp256r1,
        x402_receipt_hash,
    );
    invoke(&issue_ix, &[/* accounts */])?;
}
```

### dark_secp256k1_auth — after RegisterEthAgent

Same CPI pattern, `binding_type = BindingType::Secp256k1`, `device_pubkey` = the
recoverable ETH address (20 bytes zero-padded to 33 bytes).

---

## 9. Composability: Downstream Gating

Any program on Solana can now gate actions by checking credential token balance:

```rust
// Check: does wallet hold exactly 1 non-revoked credential token?
let agent_ata = get_associated_token_address_with_program_id(
    &agent_wallet,
    &credential_mint,
    &spl_token_2022::ID,
);
let ata_data = ctx.accounts.agent_ata.try_borrow_data()?;
let token_account = spl_token_2022::state::Account::unpack(&ata_data)?;
require!(token_account.amount == 1, PassportError::NoValidCredential);
```

This is composable with: x402 payment handlers, Dark NULL shielded pools, lottery
contracts, agent swarm coordinators — any program that needs to verify "this is a
registered agent with a live biometric/ETH binding."

---

## 10. Security Notes

- The `PermanentDelegate` PDA is program-derived — no EOA holds the burn key.
- `NonTransferable` extension is enforced by the Token-2022 runtime, not by this
  program. It cannot be bypassed by this program or the agent.
- On device upgrade, the agent MUST prove control of the new hardware device via the
  corresponding secp256r1/secp256k1 precompile. The upgrade instruction alone does not
  bypass the binding programs.
- Revocation log: the CredentialRecord PDA is never fully closed — it is zeroed and
  flagged `revoked = 0x01`. This preserves the revocation history for audit purposes.
- IS_MAINNET_READY = false: all Token-2022 CPIs are skipped in devnet mode. Only PDA
  records are written. Set `--features mainnet` before any mainnet deploy.

---

## 11. Fee Model Summary

| Action | Fee | Recipient |
|---|---|---|
| IssueCredential (first time) | 0.01 USDC | protocol_authority treasury |
| RevokeCredential | 0 (protocol-initiated) | — |
| UpgradeCredential (new device) | 0.001 USDC | protocol_authority treasury |

Payment is via x402 — the caller includes a signed payment receipt in the instruction
data. This receipt is verified on-chain (IS_MAINNET_READY = true) by checking the
receipt against the x402 settlement record.

---

## 12. Audit Surface

Programs that must be reviewed before any mainnet credential issuance:

1. `agent_credential_mint` — this program (Token-2022 CPIs, PDA writes, fee checks)
2. `dark_secp256r1_vault` — CPI caller for IssueCredential on passkey registration
3. `dark_secp256k1_auth` — CPI caller for IssueCredential on ETH binding
4. `spl-token-2022` version pinned in workspace (`spl-token-2022 = "3"`)
5. x402 receipt verification path (when IS_MAINNET_READY = true)

Status: EXTERNALLY UNAUDITED. Not reviewed by any third-party auditor.
