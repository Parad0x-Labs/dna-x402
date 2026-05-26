use dark_compression_core::*;
use sha2::{Digest, Sha256};

/// Receipt ledger backed by a LocalMerkleSimulator.
///
/// NOTE: This is NOT real ZK Compression. The underlying simulator stores
/// leaves in memory only — no on-chain compressed account is created.
pub struct CompressedReceiptLedger {
    pub backend: LocalMerkleSimulator,
    pub epoch: u64,
}

impl CompressedReceiptLedger {
    pub fn new(epoch: u64) -> Self {
        Self {
            backend: LocalMerkleSimulator::new(),
            epoch,
        }
    }

    fn owner_hash(owner_pubkey: &[u8; 32]) -> [u8; 32] {
        let mut h = Sha256::new();
        h.update(b"dark_null_v1_owner");
        h.update(owner_pubkey);
        h.finalize().into()
    }

    pub fn insert_receipt_leaf(
        &mut self,
        owner: &[u8; 32],
        receipt_hash: [u8; 32],
        scope_hash: [u8; 32],
        nullifier_hash: [u8; 32],
    ) -> Result<CompressedTreeUpdate, CompressionError> {
        let leaf = CompressedLeaf {
            domain: LeafDomain::Receipt,
            owner_hash: Self::owner_hash(owner),
            leaf_hash: receipt_hash,
            asset_or_scope_hash: scope_hash,
            nullifier_hash,
            epoch: self.epoch,
        };
        self.backend.insert_leaf(&leaf)
    }

    pub fn insert_agent_persona_leaf(
        &mut self,
        owner: &[u8; 32],
        persona_hash: [u8; 32],
        scope_hash: [u8; 32],
        nullifier_hash: [u8; 32],
    ) -> Result<CompressedTreeUpdate, CompressionError> {
        let leaf = CompressedLeaf {
            domain: LeafDomain::AgentPersona,
            owner_hash: Self::owner_hash(owner),
            leaf_hash: persona_hash,
            asset_or_scope_hash: scope_hash,
            nullifier_hash,
            epoch: self.epoch,
        };
        self.backend.insert_leaf(&leaf)
    }

    pub fn insert_api_meter_leaf(
        &mut self,
        owner: &[u8; 32],
        meter_hash: [u8; 32],
        scope_hash: [u8; 32],
        nullifier_hash: [u8; 32],
    ) -> Result<CompressedTreeUpdate, CompressionError> {
        let leaf = CompressedLeaf {
            domain: LeafDomain::ApiMeter,
            owner_hash: Self::owner_hash(owner),
            leaf_hash: meter_hash,
            asset_or_scope_hash: scope_hash,
            nullifier_hash,
            epoch: self.epoch,
        };
        self.backend.insert_leaf(&leaf)
    }

    pub fn mark_redeemed(&mut self, nullifier_hash: [u8; 32]) -> Result<(), CompressionError> {
        self.backend.mark_redeemed(nullifier_hash)
    }

    pub fn current_root(&self) -> [u8; 32] {
        self.backend.current_root()
    }

    pub fn leaf_count(&self) -> usize {
        self.backend.leaves.len()
    }

    /// Simulated cost comparison between naive PDA storage and compressed accounts.
    ///
    /// NOTE: Compressed cost is an approximation — actual cost requires Light Protocol deployment.
    pub fn cost_comparison(&self) -> CostComparison {
        let leaves = self.leaf_count() as u64;
        // Solana rent for a typical PDA: (128 + 200) bytes * 3480 lamports/byte * 2 years
        let per_pda_lamports: u64 = (128 + 200) * 3480 * 2;
        let naive_lamports = leaves * per_pda_lamports;
        // Compressed: 1 checkpoint PDA amortised over all leaves
        let checkpoint_pda_lamports: u64 = (128 + 40) * 3480 * 2;
        CostComparison {
            leaf_count: leaves,
            naive_pda_lamports: naive_lamports,
            compressed_lamports: checkpoint_pda_lamports,
            savings_lamports: naive_lamports.saturating_sub(checkpoint_pda_lamports),
            note: "SIMULATED: actual compressed account cost requires Light Protocol deployment"
                .into(),
        }
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CostComparison {
    pub leaf_count: u64,
    pub naive_pda_lamports: u64,
    pub compressed_lamports: u64,
    pub savings_lamports: u64,
    pub note: String,
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn owner() -> [u8; 32] {
        [0xAAu8; 32]
    }

    fn hashes(seed: u8) -> ([u8; 32], [u8; 32], [u8; 32]) {
        ([seed; 32], [seed + 1; 32], [seed + 2; 32])
    }

    #[test]
    fn test_insert_receipt_leaf_changes_root() {
        let mut ledger = CompressedReceiptLedger::new(1);
        let root_before = ledger.current_root();
        let (rh, sh, nh) = hashes(10);
        ledger.insert_receipt_leaf(&owner(), rh, sh, nh).unwrap();
        let root_after = ledger.current_root();
        assert_ne!(root_before, root_after);
        assert_eq!(root_before, [0u8; 32]);
        assert_ne!(root_after, [0u8; 32]);
    }

    #[test]
    fn test_double_redeem_rejected() {
        let mut ledger = CompressedReceiptLedger::new(1);
        let nullifier = [0x77u8; 32];
        ledger.mark_redeemed(nullifier).unwrap();
        let result = ledger.mark_redeemed(nullifier);
        assert_eq!(result, Err(CompressionError::NullifierAlreadyRedeemed));
    }

    #[test]
    fn test_leaf_count_increments() {
        let mut ledger = CompressedReceiptLedger::new(1);
        assert_eq!(ledger.leaf_count(), 0);
        let (rh, sh, nh) = hashes(20);
        ledger.insert_receipt_leaf(&owner(), rh, sh, nh).unwrap();
        assert_eq!(ledger.leaf_count(), 1);
        let (rh2, sh2, nh2) = hashes(30);
        ledger.insert_receipt_leaf(&owner(), rh2, sh2, nh2).unwrap();
        assert_eq!(ledger.leaf_count(), 2);
    }

    #[test]
    fn test_insert_agent_persona_leaf() {
        let mut ledger = CompressedReceiptLedger::new(2);
        let (ph, sh, nh) = hashes(40);
        let update = ledger
            .insert_agent_persona_leaf(&owner(), ph, sh, nh)
            .unwrap();
        assert_ne!(update.new_root, [0u8; 32]);
        assert_eq!(ledger.leaf_count(), 1);
    }

    #[test]
    fn test_insert_api_meter_leaf() {
        let mut ledger = CompressedReceiptLedger::new(3);
        let (mh, sh, nh) = hashes(50);
        let update = ledger.insert_api_meter_leaf(&owner(), mh, sh, nh).unwrap();
        assert_ne!(update.new_root, [0u8; 32]);
        assert_eq!(ledger.leaf_count(), 1);
    }

    #[test]
    fn test_cost_comparison_shows_savings_at_scale() {
        let mut ledger = CompressedReceiptLedger::new(1);
        // Insert 100 leaves
        for i in 0u8..100 {
            let (rh, sh, nh) = ([i; 32], [i.wrapping_add(1); 32], [i.wrapping_add(2); 32]);
            // use distinct owners to avoid hash collision
            let o = [i; 32];
            ledger.insert_receipt_leaf(&o, rh, sh, nh).unwrap();
        }
        let cmp = ledger.cost_comparison();
        assert_eq!(cmp.leaf_count, 100);
        assert!(cmp.naive_pda_lamports > cmp.compressed_lamports);
        assert!(cmp.savings_lamports > 0);
        assert!(cmp.note.contains("SIMULATED"));
    }

    #[test]
    fn test_different_domains_different_canonical_hash() {
        let base = dark_compression_core::CompressedLeaf {
            domain: LeafDomain::Receipt,
            owner_hash: [1u8; 32],
            leaf_hash: [2u8; 32],
            asset_or_scope_hash: [3u8; 32],
            nullifier_hash: [4u8; 32],
            epoch: 0,
        };
        let mut api = base.clone();
        api.domain = LeafDomain::ApiMeter;
        assert_ne!(base.canonical_hash(), api.canonical_hash());
    }

    #[test]
    fn test_root_stable_after_no_change() {
        let mut ledger = CompressedReceiptLedger::new(1);
        let (rh, sh, nh) = hashes(60);
        ledger.insert_receipt_leaf(&owner(), rh, sh, nh).unwrap();
        let root1 = ledger.current_root();
        let root2 = ledger.current_root();
        assert_eq!(root1, root2);
    }
}
