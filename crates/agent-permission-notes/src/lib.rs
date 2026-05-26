use sha2::{Digest, Sha256};

// ---------------------------------------------------------------------------
// Private helper
// ---------------------------------------------------------------------------

fn sha256_domain(domain: &[u8], inputs: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(domain);
    for i in inputs {
        h.update(i);
    }
    h.finalize().into()
}

// ---------------------------------------------------------------------------
// Constants / scope helpers
// ---------------------------------------------------------------------------

/// The "withdrawal" scope hash — spending to this scope is a withdrawal attempt.
pub fn withdraw_scope_hash() -> [u8; 32] {
    sha256_domain(b"dark_null_v1_withdraw_scope", &[])
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AgentPermissionNote {
    pub agent_id_hash: [u8; 32],
    pub max_total_spend: u64,
    pub max_single_spend: u64,
    /// empty = all scopes allowed
    pub allowed_scopes: Vec<[u8; 32]>,
    pub denied_scopes: Vec<[u8; 32]>,
    pub expiry_slot: u64,
    pub loss_fuse_hash: [u8; 32],
    pub kill_switch_root: [u8; 32],
    pub receipt_root: [u8; 32],
    pub no_withdraw: bool,
    /// set to true by revoke_session
    pub kill_switch_active: bool,
}

impl AgentPermissionNote {
    pub fn note_hash(&self) -> [u8; 32] {
        let allowed_sub = sha256_domain(
            b"dark_null_v1_allowed_scopes",
            &self
                .allowed_scopes
                .iter()
                .map(|s| s.as_ref())
                .collect::<Vec<_>>(),
        );
        let denied_sub = sha256_domain(
            b"dark_null_v1_denied_scopes",
            &self
                .denied_scopes
                .iter()
                .map(|s| s.as_ref())
                .collect::<Vec<_>>(),
        );
        sha256_domain(
            b"dark_null_v1_permission_note",
            &[
                self.agent_id_hash.as_ref(),
                &self.max_total_spend.to_le_bytes(),
                &self.max_single_spend.to_le_bytes(),
                allowed_sub.as_ref(),
                denied_sub.as_ref(),
                &self.expiry_slot.to_le_bytes(),
                self.loss_fuse_hash.as_ref(),
                self.kill_switch_root.as_ref(),
                self.receipt_root.as_ref(),
                &[self.no_withdraw as u8],
                &[self.kill_switch_active as u8],
            ],
        )
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PermissionSpend {
    pub permission_hash: [u8; 32],
    pub spend_amount: u64,
    pub scope_hash: [u8; 32],
    pub nullifier: [u8; 32],
    pub slot: u64,
}

impl PermissionSpend {
    pub fn new(
        note: &AgentPermissionNote,
        spend_amount: u64,
        scope_hash: [u8; 32],
        slot: u64,
    ) -> Self {
        let permission_hash = note.note_hash();
        let nullifier = sha256_domain(
            b"dark_null_v1_permission_nullifier",
            &[
                permission_hash.as_ref(),
                scope_hash.as_ref(),
                &slot.to_le_bytes(),
            ],
        );
        Self {
            permission_hash,
            spend_amount,
            scope_hash,
            nullifier,
            slot,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PermissionNullifier(pub [u8; 32]);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RevocationRoot(pub [u8; 32]);

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PermissionRotation {
    pub old_permission_hash: [u8; 32],
    pub new_permission_hash: [u8; 32],
    pub rotation_slot: u64,
    pub rotation_hash: [u8; 32],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PermissionError {
    WithdrawDenied,
    TotalSpendExceeded { max: u64, would_reach: u64 },
    SingleSpendExceeded { max: u64, requested: u64 },
    Expired { expiry: u64, current: u64 },
    ScopeNotAllowed,
    ScopeDenied,
    KillSwitchActive,
    PermissionHashMismatch,
}

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

/// Check whether a spend is allowed under this permission note.
///
/// Checks (in order):
/// 1. permission_hash matches note.note_hash()
/// 2. kill_switch_active = false
/// 3. current_slot <= expiry_slot
/// 4. spend_amount <= max_single_spend
/// 5. current_total_spend + spend_amount <= max_total_spend
/// 6. no_withdraw: if true and scope_hash == withdraw_scope_hash() → denied
/// 7. scope not in denied_scopes
/// 8. if allowed_scopes non-empty, scope must be in allowed_scopes
pub fn spend_allowed(
    note: &AgentPermissionNote,
    spend: &PermissionSpend,
    current_slot: u64,
    current_total_spend: u64,
) -> Result<(), PermissionError> {
    // 1. Hash integrity
    if spend.permission_hash != note.note_hash() {
        return Err(PermissionError::PermissionHashMismatch);
    }

    // 2. Kill switch
    if note.kill_switch_active {
        return Err(PermissionError::KillSwitchActive);
    }

    // 3. Expiry
    if current_slot > note.expiry_slot {
        return Err(PermissionError::Expired {
            expiry: note.expiry_slot,
            current: current_slot,
        });
    }

    // 4. Single spend limit
    if spend.spend_amount > note.max_single_spend {
        return Err(PermissionError::SingleSpendExceeded {
            max: note.max_single_spend,
            requested: spend.spend_amount,
        });
    }

    // 5. Total spend limit
    let would_reach = current_total_spend.saturating_add(spend.spend_amount);
    if would_reach > note.max_total_spend {
        return Err(PermissionError::TotalSpendExceeded {
            max: note.max_total_spend,
            would_reach,
        });
    }

    // 6. No-withdraw check
    if note.no_withdraw && spend.scope_hash == withdraw_scope_hash() {
        return Err(PermissionError::WithdrawDenied);
    }

    // 7. Denied scopes
    if note.denied_scopes.contains(&spend.scope_hash) {
        return Err(PermissionError::ScopeDenied);
    }

    // 8. Allowed scopes (empty = all allowed)
    if !note.allowed_scopes.is_empty() && !note.allowed_scopes.contains(&spend.scope_hash) {
        return Err(PermissionError::ScopeNotAllowed);
    }

    Ok(())
}

/// Produce a RevocationRoot that marks this note as revoked.
pub fn revoke_session(note: &AgentPermissionNote) -> RevocationRoot {
    let hash = sha256_domain(b"dark_null_v1_revocation", &[note.note_hash().as_ref()]);
    RevocationRoot(hash)
}

/// Record a permission rotation from old to new note.
pub fn rotate_permission(
    old_note: &AgentPermissionNote,
    new_note: &AgentPermissionNote,
    rotation_slot: u64,
) -> PermissionRotation {
    let old_permission_hash = old_note.note_hash();
    let new_permission_hash = new_note.note_hash();
    let rotation_hash = sha256_domain(
        b"dark_null_v1_rotation",
        &[
            old_permission_hash.as_ref(),
            new_permission_hash.as_ref(),
            &rotation_slot.to_le_bytes(),
        ],
    );
    PermissionRotation {
        old_permission_hash,
        new_permission_hash,
        rotation_slot,
        rotation_hash,
    }
}

/// Derive the receipt note hash for a completed spend.
pub fn derive_receipt_note(spend: &PermissionSpend) -> [u8; 32] {
    sha256_domain(
        b"dark_null_v1_receipt_note",
        &[
            spend.permission_hash.as_ref(),
            spend.nullifier.as_ref(),
            &spend.spend_amount.to_le_bytes(),
            spend.scope_hash.as_ref(),
            &spend.slot.to_le_bytes(),
        ],
    )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn make_note() -> AgentPermissionNote {
        AgentPermissionNote {
            agent_id_hash: [0xABu8; 32],
            max_total_spend: 1_000_000,
            max_single_spend: 100_000,
            allowed_scopes: vec![],
            denied_scopes: vec![],
            expiry_slot: 9999,
            loss_fuse_hash: [0u8; 32],
            kill_switch_root: [0u8; 32],
            receipt_root: [0u8; 32],
            no_withdraw: false,
            kill_switch_active: false,
        }
    }

    #[test]
    fn test_no_withdraw() {
        let mut note = make_note();
        note.no_withdraw = true;
        let scope = withdraw_scope_hash();
        let spend = PermissionSpend::new(&note, 1_000, scope, 100);
        let result = spend_allowed(&note, &spend, 100, 0);
        assert!(matches!(result, Err(PermissionError::WithdrawDenied)));
    }

    #[test]
    fn test_max_total_spend_exceeded() {
        let note = make_note();
        let spend = PermissionSpend::new(&note, 100_000, [0x01u8; 32], 100);
        // current_total=950_000 + spend=100_000 = 1_050_000 > 1_000_000
        let result = spend_allowed(&note, &spend, 100, 950_000);
        assert!(matches!(
            result,
            Err(PermissionError::TotalSpendExceeded {
                max: 1_000_000,
                would_reach: 1_050_000
            })
        ));
    }

    #[test]
    fn test_max_single_spend_exceeded() {
        let note = make_note();
        let spend = PermissionSpend::new(&note, 200_000, [0x01u8; 32], 100);
        let result = spend_allowed(&note, &spend, 100, 0);
        assert!(matches!(
            result,
            Err(PermissionError::SingleSpendExceeded {
                max: 100_000,
                requested: 200_000
            })
        ));
    }

    #[test]
    fn test_expiry() {
        let note = make_note(); // expiry_slot = 9999
        let spend = PermissionSpend::new(&note, 1_000, [0x01u8; 32], 10000);
        let result = spend_allowed(&note, &spend, 10000, 0);
        assert!(matches!(
            result,
            Err(PermissionError::Expired {
                expiry: 9999,
                current: 10000
            })
        ));
    }

    #[test]
    fn test_allowed_scope_enforced() {
        let mut note = make_note();
        note.allowed_scopes = vec![[0x02u8; 32]];
        let spend = PermissionSpend::new(&note, 1_000, [0x01u8; 32], 100);
        let result = spend_allowed(&note, &spend, 100, 0);
        assert!(matches!(result, Err(PermissionError::ScopeNotAllowed)));
    }

    #[test]
    fn test_denied_scope_blocks() {
        let mut note = make_note();
        note.denied_scopes = vec![[0x01u8; 32]];
        let spend = PermissionSpend::new(&note, 1_000, [0x01u8; 32], 100);
        let result = spend_allowed(&note, &spend, 100, 0);
        assert!(matches!(result, Err(PermissionError::ScopeDenied)));
    }

    #[test]
    fn test_kill_switch_blocks_spend() {
        let mut note = make_note();
        note.kill_switch_active = true;
        let spend = PermissionSpend::new(&note, 1_000, [0x01u8; 32], 100);
        let result = spend_allowed(&note, &spend, 100, 0);
        assert!(matches!(result, Err(PermissionError::KillSwitchActive)));
    }

    #[test]
    fn test_rotation_invalidates_old_permission() {
        let old_note = make_note();
        let mut new_note = make_note();
        new_note.max_single_spend = 50_000; // differs from old

        // Spend built against old_note
        let spend_for_old = PermissionSpend::new(&old_note, 1_000, [0x01u8; 32], 100);

        // Verify against new_note — hash mismatch
        let result = spend_allowed(&new_note, &spend_for_old, 100, 0);
        assert!(matches!(
            result,
            Err(PermissionError::PermissionHashMismatch)
        ));

        let rotation = rotate_permission(&old_note, &new_note, 200);
        assert_ne!(rotation.old_permission_hash, rotation.new_permission_hash);
    }

    #[test]
    fn test_two_agents_cannot_share_note() {
        let mut note_a = make_note();
        note_a.agent_id_hash = [0x01u8; 32];
        let mut note_b = make_note();
        note_b.agent_id_hash = [0x02u8; 32];

        assert_ne!(note_a.note_hash(), note_b.note_hash());

        // Spend built for note_a
        let spend_a = PermissionSpend::new(&note_a, 1_000, [0x01u8; 32], 100);

        // Try to use against note_b
        let result = spend_allowed(&note_b, &spend_a, 100, 0);
        assert!(matches!(
            result,
            Err(PermissionError::PermissionHashMismatch)
        ));
    }

    #[test]
    fn test_receipt_nullifier_unique_per_spend() {
        let note = make_note();

        let scope_a = [0x01u8; 32];
        let scope_b = [0x02u8; 32];

        // Same note, different scope_hash → different nullifiers
        let spend1 = PermissionSpend::new(&note, 1_000, scope_a, 100);
        let spend2 = PermissionSpend::new(&note, 1_000, scope_b, 100);
        assert_ne!(spend1.nullifier, spend2.nullifier);

        // Same note + scope, different slot → different nullifiers
        let spend3 = PermissionSpend::new(&note, 1_000, scope_a, 101);
        assert_ne!(spend1.nullifier, spend3.nullifier);

        // derive_receipt_note differs
        assert_ne!(derive_receipt_note(&spend1), derive_receipt_note(&spend2));
        assert_ne!(derive_receipt_note(&spend1), derive_receipt_note(&spend3));
    }

    #[test]
    fn test_no_private_key_in_note() {
        let note = make_note();
        let json = serde_json::to_string(&note).expect("serialize ok");
        assert!(
            !json.contains("private_key"),
            "should not contain private_key"
        );
        assert!(
            !json.contains("secret_key"),
            "should not contain secret_key"
        );
        assert!(
            json.len() < 10_000,
            "sanity: json too large ({})",
            json.len()
        );
    }
}
