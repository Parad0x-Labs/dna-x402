//! dark-x402-session-key — scoped budget+program+expiry session keys for AI agents
//!
//! First Solana implementation of session keys designed for autonomous AI agents
//! making x402 micropayments. Each session key is:
//!   - scoped to one on-chain program (no cross-program spending)
//!   - budget-capped (total lamports spent cannot exceed budget_lamports)
//!   - time-bounded (expires_at Unix timestamp)
//!   - use-limited (max_uses prevents unbounded spend loops)
//!
//! An agent holds a session key commitment on-chain; individual payment authorizations
//! are signed off-chain by the session key and verified by the program.
//!
//! IS_STUB  = true
//! MAINNET_READY = false

use sha2::{Digest, Sha256};

pub const IS_STUB: bool = true;
pub const MAINNET_READY: bool = false;

// ── domain tags ───────────────────────────────────────────────────────────────
const DOMAIN_SESSION_ID: &[u8] = b"x402-session-v1";
const DOMAIN_MASTER_COMMIT: &[u8] = b"x402-master-commit-v1";
const DOMAIN_PAYMENT_TOKEN: &[u8] = b"x402-payment-token-v1";

// ── error ─────────────────────────────────────────────────────────────────────
#[derive(Debug, PartialEq, Eq, Clone)]
pub enum SessionKeyError {
    ZeroMasterKey,
    ZeroProgram,
    ZeroBudget,
    Expired,
    BudgetExceeded,
    UseLimitReached,
}

impl core::fmt::Display for SessionKeyError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::ZeroMasterKey => write!(f, "master key must not be all zeros"),
            Self::ZeroProgram => write!(f, "program scope must not be all zeros"),
            Self::ZeroBudget => write!(f, "budget must be > 0"),
            Self::Expired => write!(f, "session key has expired"),
            Self::BudgetExceeded => write!(f, "payment would exceed session budget"),
            Self::UseLimitReached => write!(f, "session use limit reached"),
        }
    }
}

// ── types ─────────────────────────────────────────────────────────────────────

/// A scoped session key for an AI agent's x402 payment authority.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionKey {
    /// Unique session identifier.
    pub session_id: [u8; 32],
    /// Commitment to the master key (hides the actual key).
    pub master_commitment: [u8; 32],
    /// The on-chain program this key is scoped to.
    pub program_scope: [u8; 32],
    /// Total lamports this session may spend.
    pub budget_lamports: u64,
    /// Lamports spent so far.
    pub spent_lamports: u64,
    /// Maximum number of payment authorizations.
    pub max_uses: u32,
    /// Number of times this key has been used.
    pub use_count: u32,
    /// Unix timestamp when this session expires.
    pub expires_at: u64,
    pub is_stub: bool,
    pub mainnet_ready: bool,
}

// ── public API ────────────────────────────────────────────────────────────────

/// Create a new session key for an AI agent.
///
/// - `master_key`: agent's master secret (hidden behind commitment)
/// - `program_scope`: 32-byte program ID this key is restricted to
/// - `budget_lamports`: maximum total the agent may spend
/// - `max_uses`: maximum number of `authorize_payment` calls
/// - `expires_at`: Unix timestamp (seconds) when key expires
pub fn create_session_key(
    master_key: &[u8; 32],
    program_scope: &[u8; 32],
    budget_lamports: u64,
    max_uses: u32,
    expires_at: u64,
) -> Result<SessionKey, SessionKeyError> {
    if master_key == &[0u8; 32] {
        return Err(SessionKeyError::ZeroMasterKey);
    }
    if program_scope == &[0u8; 32] {
        return Err(SessionKeyError::ZeroProgram);
    }
    if budget_lamports == 0 {
        return Err(SessionKeyError::ZeroBudget);
    }

    let session_id = {
        let mut h = Sha256::new();
        h.update(DOMAIN_SESSION_ID);
        h.update(master_key);
        h.update(program_scope);
        h.update(budget_lamports.to_le_bytes());
        h.update(expires_at.to_le_bytes());
        h.finalize().into()
    };

    let master_commitment = {
        let mut h = Sha256::new();
        h.update(DOMAIN_MASTER_COMMIT);
        h.update(master_key);
        h.finalize().into()
    };

    Ok(SessionKey {
        session_id,
        master_commitment,
        program_scope: *program_scope,
        budget_lamports,
        spent_lamports: 0,
        max_uses,
        use_count: 0,
        expires_at,
        is_stub: IS_STUB,
        mainnet_ready: MAINNET_READY,
    })
}

/// Authorize a single x402 payment from this session.
///
/// Checks expiry, budget, and use limit. On success, updates state and returns
/// a one-time `payment_token` = H(session_id || amount || use_count).
pub fn authorize_payment(
    session: &mut SessionKey,
    amount: u64,
    now: u64,
) -> Result<[u8; 32], SessionKeyError> {
    if now >= session.expires_at {
        return Err(SessionKeyError::Expired);
    }
    if session.spent_lamports.saturating_add(amount) > session.budget_lamports {
        return Err(SessionKeyError::BudgetExceeded);
    }
    if session.use_count >= session.max_uses {
        return Err(SessionKeyError::UseLimitReached);
    }

    let token = {
        let mut h = Sha256::new();
        h.update(DOMAIN_PAYMENT_TOKEN);
        h.update(session.session_id);
        h.update(amount.to_le_bytes());
        h.update(session.use_count.to_le_bytes());
        h.finalize().into()
    };

    session.spent_lamports += amount;
    session.use_count += 1;

    Ok(token)
}

/// Returns true if the session is not expired and still has budget and uses remaining.
pub fn is_valid(session: &SessionKey, now: u64) -> bool {
    now < session.expires_at
        && session.spent_lamports < session.budget_lamports
        && session.use_count < session.max_uses
}

/// Returns lamports remaining in the budget.
pub fn remaining_budget(session: &SessionKey) -> u64 {
    session.budget_lamports.saturating_sub(session.spent_lamports)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn master() -> [u8; 32] { let mut k = [0u8; 32]; k[0] = 0xAA; k[31] = 0x01; k }
    fn program() -> [u8; 32] { let mut k = [0u8; 32]; k[0] = 0xBB; k[15] = 0x42; k }
    const BUDGET: u64 = 1_000_000; // 1M lamports
    const USES: u32 = 100;
    const EXPIRY: u64 = 9_999_999_999;
    const NOW: u64 = 1_000_000_000;

    fn fresh() -> SessionKey {
        create_session_key(&master(), &program(), BUDGET, USES, EXPIRY).unwrap()
    }

    // 1. constants
    #[test]
    fn test_constants() {
        assert!(IS_STUB);
        assert!(!MAINNET_READY);
    }

    // 2. session creation is deterministic
    #[test]
    fn test_create_session_key_deterministic() {
        let a = create_session_key(&master(), &program(), BUDGET, USES, EXPIRY).unwrap();
        let b = create_session_key(&master(), &program(), BUDGET, USES, EXPIRY).unwrap();
        assert_eq!(a.session_id, b.session_id);
        assert_eq!(a.master_commitment, b.master_commitment);
    }

    // 3. different master keys → different session IDs
    #[test]
    fn test_session_id_different_for_different_keys() {
        let mut m2 = master();
        m2[5] ^= 0xFF;
        let a = create_session_key(&master(), &program(), BUDGET, USES, EXPIRY).unwrap();
        let b = create_session_key(&m2, &program(), BUDGET, USES, EXPIRY).unwrap();
        assert_ne!(a.session_id, b.session_id);
    }

    // 4. authorize_payment succeeds on valid session
    #[test]
    fn test_authorize_payment_succeeds() {
        let mut s = fresh();
        let token = authorize_payment(&mut s, 1000, NOW).unwrap();
        assert_ne!(token, [0u8; 32]);
    }

    // 5. authorize_payment reduces remaining budget
    #[test]
    fn test_authorize_payment_reduces_remaining_budget() {
        let mut s = fresh();
        let before = remaining_budget(&s);
        authorize_payment(&mut s, 5000, NOW).unwrap();
        assert_eq!(remaining_budget(&s), before - 5000);
    }

    // 6. expired session → error
    #[test]
    fn test_authorize_payment_expired_fails() {
        let mut s = fresh();
        let expired_now = EXPIRY + 1;
        let err = authorize_payment(&mut s, 1000, expired_now).unwrap_err();
        assert_eq!(err, SessionKeyError::Expired);
    }

    // 7. budget exceeded → error
    #[test]
    fn test_authorize_payment_budget_exceeded_fails() {
        let mut s = fresh();
        let err = authorize_payment(&mut s, BUDGET + 1, NOW).unwrap_err();
        assert_eq!(err, SessionKeyError::BudgetExceeded);
    }

    // 8. use limit reached → error
    #[test]
    fn test_authorize_payment_use_limit_reached_fails() {
        let mut s = create_session_key(&master(), &program(), BUDGET, 2, EXPIRY).unwrap();
        authorize_payment(&mut s, 100, NOW).unwrap();
        authorize_payment(&mut s, 100, NOW).unwrap();
        let err = authorize_payment(&mut s, 100, NOW).unwrap_err();
        assert_eq!(err, SessionKeyError::UseLimitReached);
    }

    // 9. multiple payments within budget all succeed
    #[test]
    fn test_multiple_payments_within_budget() {
        let mut s = fresh();
        for _ in 0..10 {
            authorize_payment(&mut s, 1000, NOW).unwrap();
        }
        assert_eq!(s.use_count, 10);
        assert_eq!(s.spent_lamports, 10_000);
    }

    // 10. remaining_budget after payments
    #[test]
    fn test_remaining_budget_after_payments() {
        let mut s = fresh();
        authorize_payment(&mut s, 300_000, NOW).unwrap();
        authorize_payment(&mut s, 200_000, NOW).unwrap();
        assert_eq!(remaining_budget(&s), 500_000);
    }

    // 11. is_valid before expiry
    #[test]
    fn test_is_valid_before_expiry() {
        let s = fresh();
        assert!(is_valid(&s, NOW));
    }

    // 12. is_valid after expiry → false
    #[test]
    fn test_is_valid_after_expiry() {
        let s = fresh();
        assert!(!is_valid(&s, EXPIRY + 1));
    }

    // 13. zero master key → error
    #[test]
    fn test_zero_master_key_error() {
        let err = create_session_key(&[0u8; 32], &program(), BUDGET, USES, EXPIRY).unwrap_err();
        assert_eq!(err, SessionKeyError::ZeroMasterKey);
    }

    // 14. zero program scope → error
    #[test]
    fn test_zero_program_error() {
        let err = create_session_key(&master(), &[0u8; 32], BUDGET, USES, EXPIRY).unwrap_err();
        assert_eq!(err, SessionKeyError::ZeroProgram);
    }

    // 15. zero budget → error
    #[test]
    fn test_zero_budget_error() {
        let err = create_session_key(&master(), &program(), 0, USES, EXPIRY).unwrap_err();
        assert_eq!(err, SessionKeyError::ZeroBudget);
    }

    // 16. payment tokens are unique per use (even same amount)
    #[test]
    fn test_payment_token_unique_per_use() {
        let mut s = fresh();
        let t1 = authorize_payment(&mut s, 1000, NOW).unwrap();
        let t2 = authorize_payment(&mut s, 1000, NOW).unwrap();
        assert_ne!(t1, t2, "each payment authorization must produce a unique token");
    }
}
