//! Jito Bundle Cloak — multi-transaction atomic settlement with decoy cleanup.
//!
//! Standard Dark Null withdrawal:
//!   tx1: create receipt / nullifier intent
//!   tx2: settle payout (API payment, bet action, withdraw)
//!   tx3: close temp accounts / burn decoy PDAs
//!
//! All-or-nothing via Jito bundle. Decoy accounts in tx3 prevent a direct
//! wallet→withdraw fingerprint from appearing in transaction graphs.

use rand::Rng;
use solana_sdk::{
    hash::Hash,
    instruction::{AccountMeta, Instruction},
    message::{v0, VersionedMessage},
    pubkey::Pubkey,
    transaction::VersionedTransaction,
};

// ── Types ─────────────────────────────────────────────────────────────────────

pub struct BundleCloak {
    /// Ordered transactions that will be submitted as one atomic Jito bundle.
    pub txs: Vec<VersionedTransaction>,
    /// Decoy accounts used in the cleanup transaction.
    pub decoy_accounts: Vec<Pubkey>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum FingerprintError {
    /// Bundle is empty — nothing to submit.
    EmptyBundle,
    /// A transaction contains a direct mapping from `wallet` to a known
    /// withdraw/settlement account without any decoy coverage.
    DirectWalletMapping,
    /// Not enough decoy accounts to obscure the wallet presence.
    InsufficientDecoys,
}

impl std::fmt::Display for FingerprintError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FingerprintError::EmptyBundle => write!(f, "bundle cloak: empty bundle"),
            FingerprintError::DirectWalletMapping => {
                write!(f, "bundle cloak: direct wallet mapping detected")
            }
            FingerprintError::InsufficientDecoys => write!(f, "bundle cloak: insufficient decoys"),
        }
    }
}

// ── Core API ──────────────────────────────────────────────────────────────────

/// Wrap a set of settlement transactions in a `BundleCloak`.
pub fn new_bundle(txs: Vec<VersionedTransaction>) -> BundleCloak {
    BundleCloak {
        txs,
        decoy_accounts: vec![],
    }
}

/// Append a synthetic cleanup transaction that references `count` randomly-
/// generated decoy accounts alongside the bundle's existing accounts.
///
/// This breaks the direct wallet→withdraw account graph that chain-analysis
/// tools look for.
pub fn add_decoy_cleanup(bundle: &mut BundleCloak, rng: &mut impl Rng, count: usize) {
    let decoys: Vec<Pubkey> = (0..count)
        .map(|_| {
            let mut b = [0u8; 32];
            rng.fill(&mut b);
            Pubkey::from(b)
        })
        .collect();
    bundle.decoy_accounts.extend(decoys.iter().copied());

    // Build a no-op cleanup instruction that touches decoy accounts.
    let program_id = Pubkey::default(); // System program stub for the skeleton.
    let accounts: Vec<AccountMeta> = decoys
        .iter()
        .map(|pk| AccountMeta::new_readonly(*pk, false))
        .collect();
    let cleanup_ix = Instruction::new_with_bytes(program_id, &[], accounts);

    // Add as an unsigned v0 cleanup transaction.
    if let Ok(msg) =
        v0::Message::try_compile(&Pubkey::default(), &[cleanup_ix], &[], Hash::default())
    {
        bundle.txs.push(VersionedTransaction {
            signatures: vec![solana_sdk::signature::Signature::default()],
            message: VersionedMessage::V0(msg),
        });
    }
}

/// Check that no transaction in the bundle creates a direct `wallet` →
/// single-account fingerprint.
///
/// A transaction is flagged if `wallet` is its only static account (excluding
/// system/program addresses) AND there are zero decoy accounts in the bundle.
pub fn check_bundle_fingerprint(
    bundle: &BundleCloak,
    wallet: &Pubkey,
) -> Result<(), FingerprintError> {
    if bundle.txs.is_empty() {
        return Err(FingerprintError::EmptyBundle);
    }

    // If no decoys have been added, any tx with the wallet is a direct fingerprint.
    if bundle.decoy_accounts.is_empty() {
        for tx in &bundle.txs {
            if tx_contains_wallet(tx, wallet) {
                return Err(FingerprintError::DirectWalletMapping);
            }
        }
    }

    // With decoys present we accept the bundle (decoys disrupt the mapping).
    // Require at least 3 decoys if wallet appears in any tx.
    let wallet_exposed = bundle.txs.iter().any(|tx| tx_contains_wallet(tx, wallet));
    if wallet_exposed && bundle.decoy_accounts.len() < 3 {
        return Err(FingerprintError::InsufficientDecoys);
    }

    Ok(())
}

fn tx_contains_wallet(tx: &VersionedTransaction, wallet: &Pubkey) -> bool {
    match &tx.message {
        VersionedMessage::V0(msg) => msg.account_keys.contains(wallet),
        VersionedMessage::Legacy(msg) => msg.account_keys.contains(wallet),
    }
}

/// Serialize the bundle for submission to a Jito block engine endpoint.
///
/// Returns a JSON-ready `Vec<String>` of base64-encoded transactions.
/// Actual HTTP submission is the caller's responsibility.
pub fn encode_bundle(bundle: &BundleCloak) -> Vec<String> {
    use solana_sdk::bs58;
    bundle
        .txs
        .iter()
        .map(|tx| {
            let bytes = bincode_serialize(tx);
            bs58::encode(&bytes).into_string()
        })
        .collect()
}

fn bincode_serialize(tx: &VersionedTransaction) -> Vec<u8> {
    // Minimal manual serialization to avoid bincode dependency.
    // In production replace with: bincode::serialize(tx).unwrap()
    let _ = tx;
    vec![] // Placeholder — real serialization wired in integration layer.
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use rand::SeedableRng;
    use solana_sdk::instruction::AccountMeta;

    fn seeded_rng() -> rand::rngs::StdRng {
        rand::rngs::StdRng::seed_from_u64(0xC0DE_CAFE)
    }

    fn wallet_tx(wallet: &Pubkey) -> VersionedTransaction {
        let program = Pubkey::new_unique();
        let ix = Instruction::new_with_bytes(program, &[], vec![AccountMeta::new(*wallet, true)]);
        let msg = v0::Message::try_compile(wallet, &[ix], &[], Hash::default()).unwrap();
        VersionedTransaction {
            signatures: vec![solana_sdk::signature::Signature::default()],
            message: VersionedMessage::V0(msg),
        }
    }

    #[test]
    fn test_empty_bundle_fails() {
        let bundle = new_bundle(vec![]);
        let wallet = Pubkey::new_unique();
        assert_eq!(
            check_bundle_fingerprint(&bundle, &wallet),
            Err(FingerprintError::EmptyBundle)
        );
    }

    #[test]
    fn test_direct_wallet_tx_flagged() {
        let wallet = Pubkey::new_unique();
        let bundle = new_bundle(vec![wallet_tx(&wallet)]);
        assert_eq!(
            check_bundle_fingerprint(&bundle, &wallet),
            Err(FingerprintError::DirectWalletMapping)
        );
    }

    #[test]
    fn test_decoy_cleanup_breaks_direct_mapping() {
        let wallet = Pubkey::new_unique();
        let mut bundle = new_bundle(vec![wallet_tx(&wallet)]);
        let mut rng = seeded_rng();
        add_decoy_cleanup(&mut bundle, &mut rng, 5);
        assert!(
            check_bundle_fingerprint(&bundle, &wallet).is_ok(),
            "5 decoys should satisfy the fingerprint check"
        );
    }

    #[test]
    fn test_bundle_order_preserved() {
        let w1 = Pubkey::new_unique();
        let w2 = Pubkey::new_unique();
        let txs = vec![wallet_tx(&w1), wallet_tx(&w2)];
        let bundle = new_bundle(txs);
        // First tx still references w1
        assert!(tx_contains_wallet(&bundle.txs[0], &w1));
        // Second tx still references w2
        assert!(tx_contains_wallet(&bundle.txs[1], &w2));
    }

    #[test]
    fn test_insufficient_decoys_flagged() {
        let wallet = Pubkey::new_unique();
        let mut bundle = new_bundle(vec![wallet_tx(&wallet)]);
        let mut rng = seeded_rng();
        // Only 2 decoys — below the minimum of 3
        add_decoy_cleanup(&mut bundle, &mut rng, 2);
        // add_decoy_cleanup adds one cleanup tx with 2 decoy accounts.
        // bundle.decoy_accounts now has 2 → InsufficientDecoys expected.
        assert_eq!(
            check_bundle_fingerprint(&bundle, &wallet),
            Err(FingerprintError::InsufficientDecoys)
        );
    }

    #[test]
    fn test_non_wallet_tx_passes_without_decoys() {
        let wallet = Pubkey::new_unique();
        let other = Pubkey::new_unique();
        // Transaction that does NOT contain `wallet`
        let bundle = new_bundle(vec![wallet_tx(&other)]);
        assert!(check_bundle_fingerprint(&bundle, &wallet).is_ok());
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_new_bundle_empty_decoys() {
        let wallet = Pubkey::new_unique();
        let bundle = new_bundle(vec![wallet_tx(&wallet)]);
        assert!(bundle.decoy_accounts.is_empty());
    }

    #[test]
    fn test_decoy_accounts_stored() {
        let wallet = Pubkey::new_unique();
        let mut bundle = new_bundle(vec![wallet_tx(&wallet)]);
        let mut rng = seeded_rng();
        add_decoy_cleanup(&mut bundle, &mut rng, 5);
        assert_eq!(bundle.decoy_accounts.len(), 5);
    }

    #[test]
    fn test_cleanup_tx_added() {
        let wallet = Pubkey::new_unique();
        let mut bundle = new_bundle(vec![wallet_tx(&wallet)]);
        assert_eq!(bundle.txs.len(), 1);
        let mut rng = seeded_rng();
        add_decoy_cleanup(&mut bundle, &mut rng, 4);
        assert_eq!(bundle.txs.len(), 2);
    }

    #[test]
    fn test_exactly_three_decoys_ok() {
        let wallet = Pubkey::new_unique();
        let mut bundle = new_bundle(vec![wallet_tx(&wallet)]);
        let mut rng = seeded_rng();
        add_decoy_cleanup(&mut bundle, &mut rng, 3);
        assert!(check_bundle_fingerprint(&bundle, &wallet).is_ok());
    }

    #[test]
    fn test_encode_bundle_returns_correct_length() {
        let wallet = Pubkey::new_unique();
        let other = Pubkey::new_unique();
        let bundle = new_bundle(vec![wallet_tx(&wallet), wallet_tx(&other)]);
        let encoded = encode_bundle(&bundle);
        assert_eq!(encoded.len(), 2);
    }

    #[test]
    fn test_bundle_tx_count_preserved() {
        let txs: Vec<VersionedTransaction> =
            (0..4).map(|_| wallet_tx(&Pubkey::new_unique())).collect();
        let bundle = new_bundle(txs);
        assert_eq!(bundle.txs.len(), 4);
    }

    #[test]
    fn test_different_seeds_different_decoys() {
        let wallet = Pubkey::new_unique();
        let mut bundle1 = new_bundle(vec![wallet_tx(&wallet)]);
        let mut bundle2 = new_bundle(vec![wallet_tx(&wallet)]);
        let mut rng1 = rand::rngs::StdRng::seed_from_u64(0xAAAA);
        let mut rng2 = rand::rngs::StdRng::seed_from_u64(0xBBBB);
        add_decoy_cleanup(&mut bundle1, &mut rng1, 3);
        add_decoy_cleanup(&mut bundle2, &mut rng2, 3);
        assert_ne!(bundle1.decoy_accounts, bundle2.decoy_accounts);
    }

    #[test]
    fn test_fingerprint_error_display_nonempty() {
        let e1 = format!("{}", FingerprintError::EmptyBundle);
        let e2 = format!("{}", FingerprintError::DirectWalletMapping);
        let e3 = format!("{}", FingerprintError::InsufficientDecoys);
        assert!(!e1.is_empty());
        assert!(!e2.is_empty());
        assert!(!e3.is_empty());
    }

    #[test]
    fn test_multiple_decoy_rounds_accumulate() {
        let wallet = Pubkey::new_unique();
        let mut bundle = new_bundle(vec![wallet_tx(&wallet)]);
        let mut rng = seeded_rng();
        add_decoy_cleanup(&mut bundle, &mut rng, 2);
        add_decoy_cleanup(&mut bundle, &mut rng, 2);
        assert_eq!(bundle.decoy_accounts.len(), 4);
    }

    #[test]
    fn test_decoy_accounts_are_unique_pubkeys() {
        let wallet = Pubkey::new_unique();
        let mut bundle = new_bundle(vec![wallet_tx(&wallet)]);
        let mut rng = rand::rngs::StdRng::seed_from_u64(0xDEAD_BEEF);
        add_decoy_cleanup(&mut bundle, &mut rng, 8);
        // All decoy pubkeys should be distinct
        let mut deduped = bundle.decoy_accounts.clone();
        deduped.dedup();
        // StdRng with 8 random 32-byte keys should produce 8 distinct pubkeys
        assert_eq!(bundle.decoy_accounts.len(), deduped.len());
    }
}
