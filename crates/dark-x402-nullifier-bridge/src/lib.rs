//! dark-x402-nullifier-bridge
//!
//! Bridges the x402 HTTP payment protocol to Solana on-chain nullifier banks.
//!
//! ## The unique integration
//!
//! Nobody else has this pipeline:
//!
//! ```text
//! HTTP 402 payment request
//!       │
//!       ▼
//! x402 payment proof (tx sig + amount + pay_to)
//!       │
//!       ▼
//! DarkX402Receipt  (dark-x402-core)
//!       │  receipt_id() → canonical 32-byte receipt fingerprint
//!       ▼
//! BridgeNullifier  ← THIS CRATE
//!   nullifier:  SHA256("x402-null-v1" || receipt_id || scope_hash || epoch_le)
//!   shard:      bank_index(nullifier, epoch, domain)  ← same fn as on-chain program
//!   bank_pda:   PDA for (shard, epoch) — computed off-chain, verified on-chain
//!   instruction: ready-to-send InsertNullifier ix data
//!       │
//!       ▼
//! dark_nullifier_banks on-chain program
//!   → NullifierRecord PDA created
//!   → Duplicate spend IMPOSSIBLE across all 256 shards
//! ```
//!
//! mainnet_ready = false — devnet only until security audit

pub use dark_nullifier_banks::bank_index;
use dark_x402_core::DarkX402Receipt;

use sha2::{Digest, Sha256};
use solana_program::pubkey::Pubkey;

// ── Domain constant ───────────────────────────────────────────────────────────

/// Domain prefix for x402 receipt nullifiers.
/// Keeps nullifiers from colliding with any other Dark Null hash context.
pub const X402_NULLIFIER_DOMAIN: &[u8] = b"x402-null-v1";

/// On-chain program domain passed to `bank_index` — must match the program.
pub const BANK_DOMAIN: &[u8] = b"dark_null_v1";

// ── Types ─────────────────────────────────────────────────────────────────────

/// A nullifier derived from an x402 payment receipt, ready to submit
/// to `dark_nullifier_banks`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct BridgeNullifier {
    /// The 32-byte nullifier hash.
    /// Formula: `SHA256("x402-null-v1" || receipt_id || scope_hash || epoch_le8)`
    pub nullifier: [u8; 32],

    /// Target shard for `dark_nullifier_banks`.
    /// Formula: `bank_index(nullifier, epoch, b"dark_null_v1")`
    pub shard: u8,

    /// Epoch the nullifier is valid for.
    pub epoch: u64,

    /// The receipt id this was derived from (for audit trail).
    pub receipt_id: [u8; 32],

    /// Whether this nullifier came from a real devnet payment (not mock).
    pub is_real_payment: bool,

    /// mainnet_ready is always false.
    pub mainnet_ready: bool,
}

/// Error from the bridge.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BridgeError {
    /// Receipt has is_mock = true but caller requested strict mode.
    MockReceiptRejectedInStrictMode,
    /// Receipt scope hash is all-zero (indicates a corrupt receipt).
    EmptyScopeHash,
    /// Epoch zero is not allowed (means the caller didn't set it).
    EpochZero,
}

impl std::fmt::Display for BridgeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MockReceiptRejectedInStrictMode => {
                write!(
                    f,
                    "mock receipt rejected: strict mode requires a real on-chain payment"
                )
            }
            Self::EmptyScopeHash => write!(f, "receipt scope_hash is all-zero"),
            Self::EpochZero => write!(f, "epoch must be > 0"),
        }
    }
}

impl std::error::Error for BridgeError {}

// ── Core function ─────────────────────────────────────────────────────────────

/// Derive a `BridgeNullifier` from a verified x402 payment receipt.
///
/// # Parameters
/// - `receipt`     — the `DarkX402Receipt` returned by `dark-x402-core`
/// - `epoch`       — current Solana epoch (caller reads from `Clock` sysvar)
/// - `strict_mode` — if `true`, rejects receipts where `is_mock = true`
///
/// # Nullifier formula
/// ```text
/// nullifier = SHA256("x402-null-v1" || receipt_id(32) || scope_hash(32) || epoch_le8(8))
/// shard     = bank_index(nullifier, epoch, b"dark_null_v1")
/// ```
///
/// This ties every nullifier to:
///   1. The specific payment (receipt_id)
///   2. The service scope (scope_hash) — prevents cross-API reuse
///   3. The epoch — allows shard recycling after epoch rollover
pub fn derive_nullifier(
    receipt: &DarkX402Receipt,
    epoch: u64,
    strict_mode: bool,
) -> Result<BridgeNullifier, BridgeError> {
    if strict_mode && receipt.is_mock {
        return Err(BridgeError::MockReceiptRejectedInStrictMode);
    }
    if receipt.service_scope_hash == [0u8; 32] {
        return Err(BridgeError::EmptyScopeHash);
    }
    if epoch == 0 {
        return Err(BridgeError::EpochZero);
    }

    let receipt_id = receipt.receipt_id();

    // Nullifier = SHA256("x402-null-v1" || receipt_id || scope_hash || epoch_le)
    let nullifier: [u8; 32] = {
        let mut h = Sha256::new();
        h.update(X402_NULLIFIER_DOMAIN);
        h.update(receipt_id);
        h.update(receipt.service_scope_hash);
        h.update(epoch.to_le_bytes());
        h.finalize().into()
    };

    // Shard = same formula as on-chain program
    let shard = bank_index(&nullifier, epoch, BANK_DOMAIN);

    Ok(BridgeNullifier {
        nullifier,
        shard,
        epoch,
        receipt_id,
        is_real_payment: !receipt.is_mock,
        mainnet_ready: false,
    })
}

/// Build the raw instruction data bytes for `InsertNullifier` in
/// `dark_nullifier_banks`.
///
/// Data layout (matches on-chain `DarkNullifierInstruction::unpack`):
/// `[0x01, nullifier: [u8;32], epoch: u64 LE]` = 41 bytes
pub fn build_insert_instruction_data(bn: &BridgeNullifier) -> [u8; 41] {
    let mut data = [0u8; 41];
    data[0] = 0x01; // InsertNullifier discriminant
    data[1..33].copy_from_slice(&bn.nullifier);
    data[33..41].copy_from_slice(&bn.epoch.to_le_bytes());
    data
}

/// Build the raw instruction data bytes for `InitBank` in
/// `dark_nullifier_banks`.
///
/// Data layout: `[0x00, shard: u8, epoch: u64 LE]` = 10 bytes
pub fn build_init_bank_instruction_data(shard: u8, epoch: u64) -> [u8; 10] {
    let mut data = [0u8; 10];
    data[0] = 0x00; // InitBank discriminant
    data[1] = shard;
    data[2..10].copy_from_slice(&epoch.to_le_bytes());
    data
}

/// Compute the bank PDA address for (shard, epoch) off-chain.
///
/// Mirrors the on-chain PDA derivation in `dark_nullifier_banks`:
/// `PDA seeds: [b"null_bank", shard_u8, epoch_le8]`
pub fn bank_pda(program_id: &Pubkey, shard: u8, epoch: u64) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"null_bank", &[shard], &epoch.to_le_bytes()], program_id)
}

/// Compute the nullifier record PDA for a specific nullifier.
///
/// `PDA seeds: [b"null_rec", nullifier_32]`
pub fn null_rec_pda(program_id: &Pubkey, nullifier: &[u8; 32]) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"null_rec", nullifier.as_ref()], program_id)
}

/// Convenience: derive nullifier AND compute all PDAs needed for submission.
pub struct SubmissionBundle {
    pub bridge_nullifier: BridgeNullifier,
    /// Instruction data for InitBank (submit first if bank not yet created)
    pub init_bank_ix_data: [u8; 10],
    /// Instruction data for InsertNullifier
    pub insert_nullifier_ix_data: [u8; 41],
    /// Bank PDA (address, bump)
    pub bank_pda: (Pubkey, u8),
    /// Null record PDA (address, bump)
    pub null_rec_pda: (Pubkey, u8),
}

/// Build a complete `SubmissionBundle` from a receipt and program ID.
pub fn build_submission_bundle(
    receipt: &DarkX402Receipt,
    epoch: u64,
    program_id: &Pubkey,
    strict_mode: bool,
) -> Result<SubmissionBundle, BridgeError> {
    let bn = derive_nullifier(receipt, epoch, strict_mode)?;
    let init_bank_ix_data = build_init_bank_instruction_data(bn.shard, epoch);
    let insert_nullifier_ix_data = build_insert_instruction_data(&bn);
    let bank = bank_pda(program_id, bn.shard, epoch);
    let null_rec = null_rec_pda(program_id, &bn.nullifier);
    Ok(SubmissionBundle {
        init_bank_ix_data,
        insert_nullifier_ix_data,
        bank_pda: bank,
        null_rec_pda: null_rec,
        bridge_nullifier: bn,
    })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use dark_x402_core::{
        mint_receipt_note_after_payment, DarkX402Receipt, X402PaymentProof, X402PaymentRequirement,
    };
    use sha2::{Digest, Sha256};

    /// Build a minimal mock receipt using the real mint function.
    fn mock_receipt() -> DarkX402Receipt {
        let pay_to = [0xAA; 32];
        let payer = [0xBB; 32]; // different from pay_to — passes SelfPayment check

        let req = X402PaymentRequirement {
            scheme: "exact".into(),
            network: "solana-devnet".into(),
            asset: "SOL".into(),
            amount_lamports: 1_000_000,
            pay_to,
            resource: "https://api.darknull.example/resource".into(),
            expires_at_slot: 9999,
            nonce: [0xCC; 8],
            facilitator_url: None,
        };

        let proof = X402PaymentProof {
            requirement_hash: req.requirement_hash(),
            payer_pubkey: payer,
            tx_signature: "MOCK_SIG_test1234".into(),
            payment_header_hash: [0xDD; 32],
            receipt_scope_hash: req.scope_hash(),
            is_mock: true,
        };

        mint_receipt_note_after_payment(&req, &proof, b"test-response-bytes", 100)
            .expect("mock receipt mint must succeed")
    }

    #[test]
    fn test_derive_nullifier_deterministic() {
        let receipt = mock_receipt();
        let n1 = derive_nullifier(&receipt, 5, false).unwrap();
        let n2 = derive_nullifier(&receipt, 5, false).unwrap();
        assert_eq!(n1.nullifier, n2.nullifier);
        assert_eq!(n1.shard, n2.shard);
        assert!(!n1.mainnet_ready);
    }

    #[test]
    fn test_nullifier_formula_matches_expected() {
        let receipt = mock_receipt();
        let epoch = 7u64;
        let receipt_id = receipt.receipt_id();

        // Manually compute expected nullifier
        let expected: [u8; 32] = {
            let mut h = Sha256::new();
            h.update(b"x402-null-v1");
            h.update(receipt_id);
            h.update(receipt.service_scope_hash);
            h.update(epoch.to_le_bytes());
            h.finalize().into()
        };

        let bn = derive_nullifier(&receipt, epoch, false).unwrap();
        assert_eq!(bn.nullifier, expected);
    }

    #[test]
    fn test_shard_matches_bank_index() {
        let receipt = mock_receipt();
        let epoch = 3u64;
        let bn = derive_nullifier(&receipt, epoch, false).unwrap();
        let expected_shard = bank_index(&bn.nullifier, epoch, BANK_DOMAIN);
        assert_eq!(bn.shard, expected_shard);
        // Shard must be in [0, 255]
        assert!(bn.shard <= 255);
    }

    #[test]
    fn test_different_epochs_produce_different_nullifiers() {
        let receipt = mock_receipt();
        let n1 = derive_nullifier(&receipt, 1, false).unwrap();
        let n2 = derive_nullifier(&receipt, 2, false).unwrap();
        assert_ne!(n1.nullifier, n2.nullifier);
        assert_eq!(n1.receipt_id, n2.receipt_id); // same receipt
    }

    #[test]
    fn test_strict_mode_rejects_mock_receipt() {
        let receipt = mock_receipt();
        assert!(receipt.is_mock);
        let err = derive_nullifier(&receipt, 5, true).unwrap_err();
        assert_eq!(err, BridgeError::MockReceiptRejectedInStrictMode);
    }

    #[test]
    fn test_epoch_zero_rejected() {
        let receipt = mock_receipt();
        let err = derive_nullifier(&receipt, 0, false).unwrap_err();
        assert_eq!(err, BridgeError::EpochZero);
    }

    #[test]
    fn test_insert_instruction_data_layout() {
        let receipt = mock_receipt();
        let bn = derive_nullifier(&receipt, 9, false).unwrap();
        let ix_data = build_insert_instruction_data(&bn);

        assert_eq!(ix_data.len(), 41);
        assert_eq!(ix_data[0], 0x01); // InsertNullifier discriminant
        assert_eq!(&ix_data[1..33], &bn.nullifier);
        let epoch = u64::from_le_bytes(ix_data[33..41].try_into().unwrap());
        assert_eq!(epoch, bn.epoch);
    }

    #[test]
    fn test_init_bank_instruction_data_layout() {
        let shard = 42u8;
        let epoch = 99u64;
        let ix_data = build_init_bank_instruction_data(shard, epoch);

        assert_eq!(ix_data.len(), 10);
        assert_eq!(ix_data[0], 0x00); // InitBank discriminant
        assert_eq!(ix_data[1], shard);
        let parsed_epoch = u64::from_le_bytes(ix_data[2..10].try_into().unwrap());
        assert_eq!(parsed_epoch, epoch);
    }

    #[test]
    fn test_build_submission_bundle_roundtrip() {
        let receipt = mock_receipt();
        let program_id = Pubkey::new_unique();
        let epoch = 5u64;

        let bundle = build_submission_bundle(&receipt, epoch, &program_id, false).unwrap();

        // Nullifier matches standalone derive
        let standalone = derive_nullifier(&receipt, epoch, false).unwrap();
        assert_eq!(bundle.bridge_nullifier.nullifier, standalone.nullifier);
        assert_eq!(bundle.bridge_nullifier.shard, standalone.shard);

        // Bank PDA is non-zero
        let (bank_addr, _bump) = bundle.bank_pda;
        assert_ne!(bank_addr, Pubkey::default());

        // NullRec PDA is non-zero
        let (rec_addr, _bump) = bundle.null_rec_pda;
        assert_ne!(rec_addr, Pubkey::default());

        // Insert ix data has correct discriminant
        assert_eq!(bundle.insert_nullifier_ix_data[0], 0x01);

        // Not mainnet ready
        assert!(!bundle.bridge_nullifier.mainnet_ready);
    }

    #[test]
    fn test_nullifier_is_scope_bound() {
        // Two receipts with same payment but different resources → different nullifiers
        let mut r1 = mock_receipt();
        let mut r2 = mock_receipt();

        // Manually set different scope hashes
        let scope1: [u8; 32] = Sha256::new()
            .chain_update(b"dark_null_v1_x402_scope")
            .chain_update(b"https://api.darknull.example/resource-A")
            .finalize()
            .into();
        let scope2: [u8; 32] = Sha256::new()
            .chain_update(b"dark_null_v1_x402_scope")
            .chain_update(b"https://api.darknull.example/resource-B")
            .finalize()
            .into();

        r1.service_scope_hash = scope1;
        r2.service_scope_hash = scope2;

        let n1 = derive_nullifier(&r1, 5, false).unwrap();
        let n2 = derive_nullifier(&r2, 5, false).unwrap();
        assert_ne!(
            n1.nullifier, n2.nullifier,
            "nullifiers must differ across API scopes — prevents cross-API replay"
        );
    }
}
