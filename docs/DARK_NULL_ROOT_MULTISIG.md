# Dark-Null Root Updater Multisig — Specification

**Status:** Design / Partial Implementation  
**Interim mitigation:** Squads multisig `9M949AfyYCHp9hUk7crZZx3N6Y8sigyWBN6RM6tFq1q5` is set as
the pool `authority` field while the full multisig migration is pending.  
**Last updated:** 2026-06-01

---

## 1. The Threat: Single Root Authority

### What is the root?

`PoolConfig.merkle_root` is the on-chain Merkle root that every withdrawal proof
is verified against. A withdrawal succeeds if and only if the ZK proof opens a
leaf under that root and the nullifier has not been spent.

### Where is the authority today?

`PoolConfig.authority` is a single 32-byte Ed25519 public key. The `PausePool`
and `ResumePool` instructions check `authority_info.is_signer`. More critically,
any future `UpdateRoot` instruction (needed once the incremental Poseidon tree is
finalized) will require the authority signature to publish a new root.

### Why this is dangerous

| Attack surface | Consequence |
|---|---|
| Authority private key is compromised | Attacker can publish an arbitrary root. Any note they fabricate (with a known secret) becomes withdrawable. They can drain the vault. |
| Authority private key is lost | Root can never be updated. The pool is permanently stuck at its last valid root. New deposits cannot be finalized. |
| Malicious operator (insider threat) | Single key holder can silently publish a root that includes forged leaves, steal funds undetected. |
| Mempool observation + targeted key theft | A single-key signing ceremony is a single point of failure; stealing one key file = stealing all control. |

**Withdrawal correctness breaks** as soon as the root is malicious:
the ZK proof verifier will accept proofs for leaves that were never legitimately
deposited, enabling arbitrary fund extraction.

---

## 2. The Fix Design

### 2.1 Replace single authority with M-of-N multisig (Squads v4)

**Recommendation: 3-of-5 threshold.**

Squads Protocol v4 is already deployed on Solana mainnet and is used for
this project's program upgrade authority. Reusing it avoids a new dependency
and leverages audited multisig infrastructure.

The `PoolConfig.authority` field is replaced with the Squads multisig vault
PDA. All root-update and pause/resume instructions require the Squads vault
to be the signer, which means M-of-N Squads members must have approved the
transaction before it can be submitted on-chain.

```
Old:  authority: Pubkey  (single Ed25519 key, must sign)
New:  authority: Pubkey  (Squads vault PDA, must sign via Squad approval)
```

No on-chain program change is needed to the authority field type. The
enforcement happens at the Squads layer: the vault PDA only signs when M
members have approved. The dark-shielded-pool program simply checks
`authority_info.is_signer`, which is satisfied only when Squads executes
an approved transaction.

**Key distribution (recommended 3-of-5):**

| Key index | Holder | Storage |
|---|---|---|
| 1 | Lead developer | Hardware wallet (Ledger) |
| 2 | Co-founder / ops | Hardware wallet (Trezor) |
| 3 | Security advisor | Air-gapped signing machine |
| 4 | Community multisig seat | Elected validator or DAO |
| 5 | Emergency recovery | Geographically distributed seed phrase |

A 3-of-5 configuration means any 3 holders can authorize a root update.
The compromise of 2 keys does not break the system; 3 simultaneous compromises
are required, which is a materially higher bar.

### 2.2 Root updates require M-of-N approval

The on-chain flow for a root update once the incremental Poseidon tree is live:

```
1. Off-chain: compute new Merkle root from all NoteLeaf PDAs
2. Create Squads transaction proposal:
     program = dark_shielded_pool
     instruction = UpdateRoot { new_root, prev_root_hash, timelock_expiry }
3. Squads members review and approve (must reach threshold M)
4. After timelock elapses with no challenge:
     any party calls ExecuteUpdateRoot to finalize
5. PoolConfig.merkle_root is updated on-chain
```

No root update can be published without M independent signers agreeing.

### 2.3 Delayed publication: 1-hour timelock

Every root update is a two-phase operation:

**Phase 1 — Propose**
A new `RootProposal` PDA is created:

```
Seeds: [b"root_proposal", pool_config_key, &proposal_nonce.to_le_bytes()]

RootProposal {
    nonce:              u64,
    proposed_root:      [u8; 32],
    prev_root_hash:     [u8; 32],   // SHA-256(current merkle_root) — chain anchor
    proposer:           Pubkey,     // must be authority (Squads vault)
    proposed_at_slot:   u64,        // Clock::get().slot at proposal time
    timelock_seconds:   u64,        // minimum 3_600 (1 hour)
    is_finalized:       bool,
    is_challenged:      bool,
}
```

**Phase 2 — Execute (after timelock)**
A separate `ExecuteUpdateRoot` instruction reads the `RootProposal` PDA,
verifies `Clock::get().unix_timestamp >= proposed_at + timelock_seconds`,
verifies `!is_challenged`, and then writes `proposed_root` to `PoolConfig.merkle_root`.

The 1-hour window gives monitoring infrastructure and watchers time to
detect and challenge an invalid root before it takes effect.

### 2.4 Append-only root chain

Each `RootProposal` includes `prev_root_hash = SHA-256(current_merkle_root)`.

On finalization, the program verifies:

```rust
sha256(config.merkle_root) == proposal.prev_root_hash
```

This makes the root history a hash chain: you cannot propose a new root
without committing to the exact previous root. If an attacker tries to
silently skip or overwrite a historical root, the chain check fails.

An off-chain indexer can reconstruct the full root history by following
`prev_root_hash` pointers across all finalized `RootProposal` accounts.

### 2.5 Challenge window: fraud proofs within the timelock period

During the 1-hour timelock, any party can submit a `ChallengeRoot` instruction:

```
ChallengeRoot {
    proposal_nonce: u64,
    fraud_proof:    FraudProofData,
}

FraudProofData (enum):
    LeafNotInTree {
        claimed_leaf_index: u64,
        // absence proof: all sibling hashes along the path evaluate to
        // a root that does NOT match proposed_root
        sibling_hashes: [[u8; 32]; TREE_DEPTH],
    }
    RootMismatch {
        // off-chain recomputed root using all NoteLeaf PDAs passed as accounts
        // the program re-hashes them and verifies proposed_root != correct_root
        note_leaf_accounts: Vec<Pubkey>,  // passed via remaining_accounts
    }
```

If a valid fraud proof is submitted:
- `RootProposal.is_challenged` is set to `true`
- The proposal can never be finalized
- The current `PoolConfig.merkle_root` is unchanged
- The challenger receives a configurable bounty (lamports from a protocol reserve)

The fraud-proof verification is computationally bounded: for `RootMismatch`,
the challenger passes all leaf accounts; the program iterates them and
recomputes the Poseidon Merkle root on-chain. If the recomputed root differs
from `proposed_root`, the challenge succeeds.

---

## 3. Implementation Steps: What Needs Changing in the Rust Program

### 3.1 New state types (state.rs)

Add `RootProposalState` and `RootProposalRecord`:

```rust
/// PDA for a pending root update. Created by ProposeUpdateRoot.
/// Seeds: [b"root_proposal", pool_config_key, &nonce.to_le_bytes()]
pub const ROOT_PROPOSAL_LEN: usize = 1 + 8 + 32 + 32 + 32 + 8 + 8 + 1 + 1; // 124

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct RootProposal {
    pub bump:             u8,
    pub nonce:            u64,
    pub proposed_root:    [u8; 32],
    pub prev_root_hash:   [u8; 32],  // SHA-256(old merkle_root)
    pub proposer:         [u8; 32],  // must equal config.authority
    pub proposed_at:      i64,       // unix_timestamp at proposal
    pub timelock_seconds: u64,
    pub is_finalized:     bool,
    pub is_challenged:    bool,
}
```

Add `proposal_nonce: u64` to `PoolConfig` (use part of the existing 32-byte
`_pad` reserved region — increment it on every successful root update to keep
nonces monotonically increasing and prevent replay).

### 3.2 New instructions (instruction.rs)

```rust
pub enum PoolInstruction {
    // ... existing variants unchanged ...

    /// Propose a new Merkle root update (authority/Squads multisig must sign).
    /// Creates a RootProposal PDA with a timelock.
    ProposeUpdateRoot {
        proposed_root:    [u8; 32],
        timelock_seconds: u64,  // minimum enforced: 3_600
    },

    /// Finalize a root update after the timelock has elapsed and no challenge.
    /// Permissionless — anyone can call this after the timelock.
    ExecuteUpdateRoot {
        proposal_nonce: u64,
    },

    /// Submit a fraud proof to cancel a pending root proposal.
    /// Permissionless — any party can challenge.
    ChallengeRoot {
        proposal_nonce:      u64,
        fraud_proof_variant: u8,   // 0 = LeafNotInTree, 1 = RootMismatch
        // Remaining accounts carry leaf PDAs for RootMismatch variant
    },
}
```

### 3.3 Processor additions (processor.rs)

**`process_propose_update_root`**
- Check `authority_info.is_signer` (Squads vault must sign)
- Check `proposed_root != [0u8; 32]`
- Compute `prev_root_hash = sha256(config.merkle_root)`
- Create `RootProposal` PDA
- Emit `msg!("RootProposal: nonce={} root={:?}", nonce, proposed_root)`

**`process_execute_update_root`**
- Load `RootProposal` PDA
- Check `!proposal.is_finalized && !proposal.is_challenged`
- Check `Clock::unix_timestamp >= proposal.proposed_at + proposal.timelock_seconds as i64`
- Check `sha256(config.merkle_root) == proposal.prev_root_hash` (chain integrity)
- Write `config.merkle_root = proposal.proposed_root`
- Increment `config.proposal_nonce`
- Mark `proposal.is_finalized = true`

**`process_challenge_root`**
- Load `RootProposal` PDA
- Check `!proposal.is_finalized && !proposal.is_challenged`
- Check timelock has NOT elapsed (challenges only valid during window)
- Execute fraud proof logic:
  - Variant 0 (`LeafNotInTree`): verify Merkle non-inclusion using sibling hashes
  - Variant 1 (`RootMismatch`): iterate remaining_accounts as NoteLeaf PDAs,
    rebuild Poseidon tree, compare to `proposal.proposed_root`
- If proof valid: set `proposal.is_challenged = true`, pay bounty to challenger

### 3.4 Error codes (error.rs)

```rust
// Add to ShieldedPoolError:
RootProposalStillTimelocked  = 11,  // timelock not yet elapsed
RootProposalAlreadyFinalized = 12,
RootProposalChallenged       = 13,
RootChainBroken              = 14,  // prev_root_hash mismatch
TimelockTooShort             = 15,  // < 3_600 seconds
FraudProofInvalid            = 16,
```

### 3.5 Migration path for existing pools

1. Deploy updated program (new instructions are additive; existing state layout
   unchanged except `proposal_nonce` occupies 8 bytes of the reserved `_pad`).
2. Use Squads multisig `9M949AfyYCHp9hUk7crZZx3N6Y8sigyWBN6RM6tFq1q5` as
   the pool authority from day one (already the case — see interim mitigation
   below).
3. Any direct `authority` field transitions require an `UpdateAuthority`
   instruction gated behind the existing authority; this should be proposed
   and executed through Squads.

---

## 4. Interim Mitigation (Current State)

While the full timelock + fraud-proof mechanism is being implemented,
the following is in place:

**Squads multisig `9M949AfyYCHp9hUk7crZZx3N6Y8sigyWBN6RM6tFq1q5` is set as
`PoolConfig.authority`.**

This means:

- Any `PausePool` / `ResumePool` instruction must be signed by the Squads vault
  PDA, requiring M-of-N Squads approval before it can execute.
- Once a `ProposeUpdateRoot` instruction is added, it will be gated the same way.
- Key compromise of a single Squads member does not grant root-update capability.

This does NOT provide the timelock or challenge window. A malicious or
compromised majority of Squads signers could still publish a malicious root
(after meeting the M threshold). The timelock + fraud proof layer is the
remaining piece needed for full security.

**Risk residual under interim mitigation:**

| Risk | Mitigated? |
|---|---|
| Single key compromise | Yes (M-of-N required) |
| Insider threat (single operator) | Partial (M threshold required) |
| Malicious majority of Squads | No (full timelock needed) |
| Silent root rewrite | No (append-only chain not yet enforced) |
| 1-hour watcher window | No (timelock not yet implemented) |

**Monitoring:** Until the timelock is live, watchers should subscribe to
program logs for the `dark_shielded_pool` program ID and alert on any
root-changing instruction. A 1-hour human-response SLA is the manual
equivalent of the timelock during this interim period.

---

## 5. References

- `programs/dark_shielded_pool/src/state.rs` — `PoolConfig.authority` field
- `programs/dark_shielded_pool/src/processor.rs` — `process_pause` (authority check pattern)
- `programs/dark_shielded_pool/src/lib.rs` — IS_STUB / MAINNET_READY gates
- `docs/UPGRADE_AUTHORITY.md` — Squads multisig usage for program upgrades
- Squads v4 docs: https://docs.squads.so/squads-v4
- SIMD-0359 (Poseidon syscall): https://github.com/solana-foundation/solana-improvement-documents/pull/159
