use sha2::{Digest, Sha256};
use std::collections::HashSet;

pub const DOMAIN_KILL: u8 = 0xA0;

#[derive(Clone, Debug)]
pub struct RevocationCapsule {
    pub session_id: [u8; 32],
    pub user_commitment: [u8; 32], // proves user owns session
    pub revoked_at_slot: u64,
    pub reason_hash: [u8; 32],
}

impl RevocationCapsule {
    pub fn new(
        session_id: [u8; 32],
        user_secret: &[u8; 32],
        revoked_at_slot: u64,
        reason: &str,
    ) -> Self {
        let mut user_h = Sha256::new();
        user_h.update([DOMAIN_KILL, 0x01]);
        user_h.update(user_secret);
        user_h.update(&session_id);
        let user_commitment = user_h.finalize().into();

        let mut reason_h = Sha256::new();
        reason_h.update([DOMAIN_KILL, 0x02]);
        reason_h.update(reason.as_bytes());
        let reason_hash = reason_h.finalize().into();

        Self {
            session_id,
            user_commitment,
            revoked_at_slot,
            reason_hash,
        }
    }

    pub fn capsule_hash(&self) -> [u8; 32] {
        let mut h = Sha256::new();
        h.update([DOMAIN_KILL]);
        h.update(&self.session_id);
        h.update(&self.user_commitment);
        h.update(self.revoked_at_slot.to_le_bytes());
        h.update(&self.reason_hash);
        h.finalize().into()
    }

    pub fn verify_user(&self, user_secret: &[u8; 32]) -> bool {
        let mut h = Sha256::new();
        h.update([DOMAIN_KILL, 0x01]);
        h.update(user_secret);
        h.update(&self.session_id);
        let expected: [u8; 32] = h.finalize().into();
        expected == self.user_commitment
    }
}

pub struct RevocationRegistry {
    pub revoked: HashSet<[u8; 32]>, // keyed by session_id
}

impl RevocationRegistry {
    pub fn new() -> Self {
        Self {
            revoked: HashSet::new(),
        }
    }

    pub fn revoke(
        &mut self,
        capsule: &RevocationCapsule,
        user_secret: &[u8; 32],
    ) -> Result<(), KillError> {
        if !capsule.verify_user(user_secret) {
            return Err(KillError::WrongUser);
        }
        self.revoked.insert(capsule.session_id);
        Ok(())
    }

    pub fn is_revoked(&self, session_id: &[u8; 32]) -> bool {
        self.revoked.contains(session_id)
    }

    pub fn check_spend(&self, session_id: &[u8; 32]) -> Result<(), KillError> {
        if self.is_revoked(session_id) {
            Err(KillError::SessionRevoked)
        } else {
            Ok(())
        }
    }
}

impl Default for RevocationRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum KillError {
    WrongUser,
    SessionRevoked,
    CannotForgeCapsule,
}

#[cfg(test)]
mod tests {
    use super::*;

    const SESSION: [u8; 32] = [0x11u8; 32];
    const SECRET: [u8; 32] = [0x22u8; 32];
    const WRONG_SECRET: [u8; 32] = [0x99u8; 32];

    fn make_capsule() -> RevocationCapsule {
        RevocationCapsule::new(SESSION, &SECRET, 12345, "user_requested")
    }

    #[test]
    fn test_revoke_and_check() {
        let capsule = make_capsule();
        let mut registry = RevocationRegistry::new();
        assert!(!registry.is_revoked(&SESSION));
        registry.revoke(&capsule, &SECRET).unwrap();
        assert!(registry.is_revoked(&SESSION));
        assert_eq!(
            registry.check_spend(&SESSION),
            Err(KillError::SessionRevoked)
        );
    }

    #[test]
    fn test_unrelated_session_unaffected() {
        let capsule = make_capsule();
        let mut registry = RevocationRegistry::new();
        registry.revoke(&capsule, &SECRET).unwrap();

        let other_session = [0x55u8; 32];
        assert!(!registry.is_revoked(&other_session));
        assert!(registry.check_spend(&other_session).is_ok());
    }

    #[test]
    fn test_wrong_user_rejected() {
        let capsule = make_capsule();
        let mut registry = RevocationRegistry::new();
        let result = registry.revoke(&capsule, &WRONG_SECRET);
        assert_eq!(result, Err(KillError::WrongUser));
        // Session must NOT be revoked after failed attempt
        assert!(!registry.is_revoked(&SESSION));
    }

    #[test]
    fn test_spend_after_revoke_rejected() {
        let capsule = make_capsule();
        let mut registry = RevocationRegistry::new();
        // Before revoke: spend allowed
        assert!(registry.check_spend(&SESSION).is_ok());
        registry.revoke(&capsule, &SECRET).unwrap();
        // After revoke: spend rejected
        assert_eq!(
            registry.check_spend(&SESSION),
            Err(KillError::SessionRevoked)
        );
    }

    #[test]
    fn test_capsule_hash_stable() {
        let capsule = make_capsule();
        let h1 = capsule.capsule_hash();
        let h2 = capsule.capsule_hash();
        assert_eq!(h1, h2);

        // Different slot -> different hash
        let capsule2 = RevocationCapsule::new(SESSION, &SECRET, 99999, "user_requested");
        assert_ne!(h1, capsule2.capsule_hash());
    }

    #[test]
    fn test_reason_hash_changes() {
        let c1 = RevocationCapsule::new(SESSION, &SECRET, 1, "reason_a");
        let c2 = RevocationCapsule::new(SESSION, &SECRET, 1, "reason_b");
        assert_ne!(c1.reason_hash, c2.reason_hash);
        assert_ne!(c1.capsule_hash(), c2.capsule_hash());
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_verify_user_succeeds_with_correct_secret() {
        let capsule = make_capsule();
        assert!(capsule.verify_user(&SECRET));
    }

    #[test]
    fn test_verify_user_fails_wrong_secret() {
        let capsule = make_capsule();
        assert!(!capsule.verify_user(&WRONG_SECRET));
    }

    #[test]
    fn test_user_commitment_deterministic() {
        let c1 = RevocationCapsule::new(SESSION, &SECRET, 12345, "reason");
        let c2 = RevocationCapsule::new(SESSION, &SECRET, 12345, "reason");
        assert_eq!(c1.user_commitment, c2.user_commitment);
    }

    #[test]
    fn test_user_commitment_secret_sensitive() {
        let c1 = RevocationCapsule::new(SESSION, &SECRET, 0, "reason");
        let c2 = RevocationCapsule::new(SESSION, &WRONG_SECRET, 0, "reason");
        assert_ne!(c1.user_commitment, c2.user_commitment);
    }

    #[test]
    fn test_capsule_hash_session_sensitive() {
        let c1 = RevocationCapsule::new(SESSION, &SECRET, 0, "reason");
        let other_session = [0x77u8; 32];
        let c2 = RevocationCapsule::new(other_session, &SECRET, 0, "reason");
        assert_ne!(c1.capsule_hash(), c2.capsule_hash());
    }

    #[test]
    fn test_check_spend_ok_before_revoke() {
        let registry = RevocationRegistry::new();
        assert!(registry.check_spend(&SESSION).is_ok());
    }

    #[test]
    fn test_revoke_idempotent() {
        let capsule = make_capsule();
        let mut registry = RevocationRegistry::new();
        registry.revoke(&capsule, &SECRET).unwrap();
        // Second insert into HashSet is a no-op
        registry.revoke(&capsule, &SECRET).unwrap();
        assert!(registry.is_revoked(&SESSION));
    }

    #[test]
    fn test_capsule_hash_reason_sensitive() {
        let c1 = RevocationCapsule::new(SESSION, &SECRET, 0, "reason_x");
        let c2 = RevocationCapsule::new(SESSION, &SECRET, 0, "reason_y");
        assert_ne!(c1.capsule_hash(), c2.capsule_hash());
    }

    #[test]
    fn test_multiple_sessions_revoked() {
        let s1 = [0x01u8; 32];
        let s2 = [0x02u8; 32];
        let c1 = RevocationCapsule::new(s1, &SECRET, 0, "r");
        let c2 = RevocationCapsule::new(s2, &SECRET, 0, "r");
        let mut registry = RevocationRegistry::new();
        registry.revoke(&c1, &SECRET).unwrap();
        registry.revoke(&c2, &SECRET).unwrap();
        assert!(registry.is_revoked(&s1));
        assert!(registry.is_revoked(&s2));
    }

    #[test]
    fn test_cannot_forge_other_user_capsule() {
        let attacker_secret = [0xAAu8; 32];
        let capsule = make_capsule(); // owned by SECRET
        let mut registry = RevocationRegistry::new();
        let err = registry.revoke(&capsule, &attacker_secret);
        assert_eq!(err, Err(KillError::WrongUser));
        assert!(!registry.is_revoked(&SESSION));
    }
}
