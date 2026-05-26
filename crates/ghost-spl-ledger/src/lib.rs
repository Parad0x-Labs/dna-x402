use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// A virtual balance — no on-chain token account required.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct VirtualBalance {
    /// Opaque owner identifier (e.g. H(wallet_pubkey || session_nonce)).
    pub owner_hash: [u8; 32],
    /// SPL mint (32-byte pubkey).
    pub asset_mint: [u8; 32],
    /// Lamports / token units.
    pub balance: u64,
    /// Maximum spend per operation.
    pub cap: u64,
    /// Monotone nonce preventing replay.
    pub nonce: u64,
}

/// Commitment = H(owner_hash || asset_mint || balance || cap || nonce).
pub fn commit(v: &VirtualBalance) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(&v.owner_hash);
    h.update(&v.asset_mint);
    h.update(&v.balance.to_le_bytes());
    h.update(&v.cap.to_le_bytes());
    h.update(&v.nonce.to_le_bytes());
    h.finalize().into()
}

#[derive(Debug, PartialEq, Eq)]
pub enum LedgerError {
    InsufficientBalance,
    OverCap,
    NonceReplay,
}

/// Spend `amount` from the virtual balance. Returns updated commitment.
pub fn spend(v: &mut VirtualBalance, amount: u64) -> Result<[u8; 32], LedgerError> {
    if amount > v.cap {
        return Err(LedgerError::OverCap);
    }
    if amount > v.balance {
        return Err(LedgerError::InsufficientBalance);
    }
    v.balance -= amount;
    v.nonce += 1;
    Ok(commit(v))
}

/// Deposit `amount` into the virtual balance.
pub fn deposit(v: &mut VirtualBalance, amount: u64) -> [u8; 32] {
    v.balance = v.balance.saturating_add(amount);
    v.nonce += 1;
    commit(v)
}

/// An exit intent: the owner wants to materialize `amount` as a real ATA.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExitIntent {
    pub owner_hash: [u8; 32],
    pub asset_mint: [u8; 32],
    pub amount: u64,
    pub pre_commitment: [u8; 32],
}

pub fn create_exit_intent(v: &VirtualBalance, amount: u64) -> Result<ExitIntent, LedgerError> {
    if amount > v.balance {
        return Err(LedgerError::InsufficientBalance);
    }
    Ok(ExitIntent {
        owner_hash: v.owner_hash,
        asset_mint: v.asset_mint,
        amount,
        pre_commitment: commit(v),
    })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> VirtualBalance {
        VirtualBalance {
            owner_hash: [0x01u8; 32],
            asset_mint: [0x02u8; 32],
            balance: 1_000,
            cap: 500,
            nonce: 0,
        }
    }

    #[test]
    fn test_deposit_increases_balance() {
        let mut v = sample();
        let before = v.balance;
        deposit(&mut v, 100);
        assert_eq!(v.balance, before + 100);
    }

    #[test]
    fn test_spend_decreases_balance() {
        let mut v = sample();
        let pre = commit(&v);
        let before = v.balance;
        let post = spend(&mut v, 50).unwrap();
        assert_eq!(v.balance, before - 50);
        assert_ne!(pre, post, "commitment must change after spend");
    }

    #[test]
    fn test_spend_over_cap_rejected() {
        let mut v = sample(); // cap = 500
        assert_eq!(spend(&mut v, 501), Err(LedgerError::OverCap));
    }

    #[test]
    fn test_spend_insufficient_balance_rejected() {
        // First drain balance to 100 via deposits then create a scenario
        let mut v2 = VirtualBalance {
            balance: 40,
            cap: 500,
            ..sample()
        };
        assert_eq!(spend(&mut v2, 41), Err(LedgerError::InsufficientBalance));
    }

    #[test]
    fn test_commitment_changes_after_spend() {
        let mut v = sample();
        let pre = commit(&v);
        spend(&mut v, 100).unwrap();
        let post = commit(&v);
        assert_ne!(pre, post);
    }

    #[test]
    fn test_exit_intent_ok() {
        let v = sample();
        let intent = create_exit_intent(&v, 100).unwrap();
        assert_eq!(intent.amount, 100);
        assert_eq!(intent.owner_hash, v.owner_hash);
        assert_eq!(intent.asset_mint, v.asset_mint);
        assert_eq!(intent.pre_commitment, commit(&v));
    }

    #[test]
    fn test_exit_intent_over_balance() {
        let v = sample(); // balance = 1000
        assert_eq!(
            create_exit_intent(&v, 1001),
            Err(LedgerError::InsufficientBalance)
        );
    }

    #[test]
    fn test_json_roundtrip() {
        let v = sample();
        let json = serde_json::to_string(&v).unwrap();
        let v2: VirtualBalance = serde_json::from_str(&json).unwrap();
        assert_eq!(v, v2);
    }
}
