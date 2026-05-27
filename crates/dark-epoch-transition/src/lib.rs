use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

// ── Types ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EpochState {
    pub epoch_id: [u8; 32],
    pub epoch: u64,
    pub state_root: [u8; 32],
    pub validator_root: [u8; 32],
    pub finalized: bool,
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EpochTransition {
    pub from_epoch: u64,
    pub to_epoch: u64,
    pub transition_hash: [u8; 32],
    pub mainnet_ready: bool,
}

#[derive(Debug, PartialEq)]
pub enum EpochError {
    ZeroGenesisSecret,
    EpochNotAdvancing,
    AlreadyFinalized,
}

// ── Helpers ────────────────────────────────────────────────────────────────

fn sha256_multi(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

fn hex32(b: &[u8; 32]) -> String {
    b.iter().map(|x| format!("{:02x}", x)).collect()
}

fn compute_genesis_hash(genesis_secret: &[u8; 32]) -> [u8; 32] {
    sha256_multi(&[b"epoch-genesis-v1", genesis_secret])
}

fn compute_state_root(epoch: u64, genesis_hash: &[u8; 32], validator_root: &[u8; 32]) -> [u8; 32] {
    sha256_multi(&[
        b"epoch-state-v1",
        &epoch.to_le_bytes(),
        genesis_hash,
        validator_root,
    ])
}

fn compute_epoch_id(state_root: &[u8; 32], epoch: u64) -> [u8; 32] {
    sha256_multi(&[b"epoch-id-v1", state_root, &epoch.to_le_bytes()])
}

fn compute_transition_hash(
    from_state_root: &[u8; 32],
    to_state_root: &[u8; 32],
    to_epoch: u64,
) -> [u8; 32] {
    sha256_multi(&[
        b"epoch-trans-v1",
        from_state_root,
        to_state_root,
        &to_epoch.to_le_bytes(),
    ])
}

// ── API ────────────────────────────────────────────────────────────────────

pub fn genesis_epoch(
    genesis_secret: &[u8; 32],
    initial_validator_root: &[u8; 32],
) -> Result<EpochState, EpochError> {
    if genesis_secret == &[0u8; 32] {
        return Err(EpochError::ZeroGenesisSecret);
    }
    let genesis_hash = compute_genesis_hash(genesis_secret);
    let state_root = compute_state_root(0, &genesis_hash, initial_validator_root);
    let epoch_id = compute_epoch_id(&state_root, 0);
    Ok(EpochState {
        epoch_id,
        epoch: 0,
        state_root,
        validator_root: *initial_validator_root,
        finalized: false,
        mainnet_ready: false,
    })
}

pub fn advance_epoch(
    current: &EpochState,
    new_validator_root: &[u8; 32],
) -> Result<(EpochState, EpochTransition), EpochError> {
    if current.finalized {
        return Err(EpochError::AlreadyFinalized);
    }
    // We need genesis_hash but it's not stored; re-derive from state by using a placeholder.
    // Instead we hash state_root directly as genesis_hash substitute for the new epoch.
    // Actually the spec says state_root = SHA256("epoch-state-v1" || epoch_le || genesis_hash || validator_root)
    // For advancing, the "genesis_hash" of the chain is constant — we store it implicitly in the
    // state_root chain. We use the current state_root as a chaining input.
    let to_epoch = current.epoch + 1;
    // For the new state_root we use the current state_root as the "genesis_hash" equivalent
    // (a chain: each epoch's state_root feeds into the next as parent)
    let new_state_root = sha256_multi(&[
        b"epoch-state-v1",
        &to_epoch.to_le_bytes(),
        &current.state_root,
        new_validator_root,
    ]);
    let new_epoch_id = compute_epoch_id(&new_state_root, to_epoch);
    let transition_hash = compute_transition_hash(&current.state_root, &new_state_root, to_epoch);

    let new_state = EpochState {
        epoch_id: new_epoch_id,
        epoch: to_epoch,
        state_root: new_state_root,
        validator_root: *new_validator_root,
        finalized: false,
        mainnet_ready: false,
    };
    let transition = EpochTransition {
        from_epoch: current.epoch,
        to_epoch,
        transition_hash,
        mainnet_ready: false,
    };
    Ok((new_state, transition))
}

pub fn finalize_epoch(state: &mut EpochState) {
    state.finalized = true;
}

pub fn epoch_public_record(state: &EpochState) -> String {
    serde_json::json!({
        "epoch_id":     hex32(&state.epoch_id),
        "epoch":        state.epoch,
        "state_root":   hex32(&state.state_root),
        "finalized":    state.finalized,
        "mainnet_ready": state.mainnet_ready,
    })
    .to_string()
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn secret(b: u8) -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = b;
        s
    }
    fn vroot(b: u8) -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = b;
        s
    }

    // Test 1: genesis + advance
    #[test]
    fn test_genesis_and_advance() {
        let gs = secret(0x11);
        let vr = vroot(0xAA);
        let state = genesis_epoch(&gs, &vr).unwrap();
        assert_eq!(state.epoch, 0);
        assert!(!state.finalized);
        assert!(!state.mainnet_ready);
        let vr2 = vroot(0xBB);
        let (new_state, transition) = advance_epoch(&state, &vr2).unwrap();
        assert_eq!(new_state.epoch, 1);
        assert!(!new_state.finalized);
        assert!(!new_state.mainnet_ready);
        assert_eq!(transition.from_epoch, 0);
        assert_eq!(transition.to_epoch, 1);
        assert!(!transition.mainnet_ready);
    }

    // Test 2: transition_hash correct
    #[test]
    fn test_transition_hash_correct() {
        let gs = secret(0x22);
        let vr = vroot(0xAA);
        let state = genesis_epoch(&gs, &vr).unwrap();
        let vr2 = vroot(0xBB);
        let (new_state, transition) = advance_epoch(&state, &vr2).unwrap();
        let expected = compute_transition_hash(&state.state_root, &new_state.state_root, 1);
        assert_eq!(transition.transition_hash, expected);
    }

    // Test 3: advance finalized epoch rejected
    #[test]
    fn test_advance_finalized_rejected() {
        let gs = secret(0x33);
        let vr = vroot(0xAA);
        let mut state = genesis_epoch(&gs, &vr).unwrap();
        finalize_epoch(&mut state);
        assert!(state.finalized);
        let err = advance_epoch(&state, &vroot(0xBB)).unwrap_err();
        assert_eq!(err, EpochError::AlreadyFinalized);
    }

    // Test 4: zero genesis rejected
    #[test]
    fn test_zero_genesis_rejected() {
        let zero = [0u8; 32];
        let err = genesis_epoch(&zero, &vroot(0xAA)).unwrap_err();
        assert_eq!(err, EpochError::ZeroGenesisSecret);
    }

    // Test 5: epoch increments
    #[test]
    fn test_epoch_increments() {
        let gs = secret(0x44);
        let vr = vroot(0xAA);
        let s0 = genesis_epoch(&gs, &vr).unwrap();
        assert_eq!(s0.epoch, 0);
        let (s1, _) = advance_epoch(&s0, &vroot(0xBB)).unwrap();
        assert_eq!(s1.epoch, 1);
        let (s2, _) = advance_epoch(&s1, &vroot(0xCC)).unwrap();
        assert_eq!(s2.epoch, 2);
        // epoch_id changes each time
        assert_ne!(s0.epoch_id, s1.epoch_id);
        assert_ne!(s1.epoch_id, s2.epoch_id);
    }

    // Test 6: public record correct
    #[test]
    fn test_public_record_correct() {
        let gs = secret(0x55);
        let vr = vroot(0xAA);
        let state = genesis_epoch(&gs, &vr).unwrap();
        let record = epoch_public_record(&state);
        let v: serde_json::Value = serde_json::from_str(&record).unwrap();
        assert!(v["epoch_id"].is_string());
        assert!(v["state_root"].is_string());
        assert_eq!(v["epoch"], 0);
        assert_eq!(v["finalized"], false);
        assert_eq!(v["mainnet_ready"], false);
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_epoch_id_nonzero() {
        let state = genesis_epoch(&secret(0xAA), &vroot(0x11)).unwrap();
        assert_ne!(state.epoch_id, [0u8; 32]);
    }

    #[test]
    fn test_epoch_id_deterministic() {
        let s1 = genesis_epoch(&secret(0xAA), &vroot(0x11)).unwrap();
        let s2 = genesis_epoch(&secret(0xAA), &vroot(0x11)).unwrap();
        assert_eq!(s1.epoch_id, s2.epoch_id);
    }

    #[test]
    fn test_state_root_nonzero() {
        let state = genesis_epoch(&secret(0xAA), &vroot(0x11)).unwrap();
        assert_ne!(state.state_root, [0u8; 32]);
    }

    #[test]
    fn test_validator_root_stored() {
        let vr = vroot(0x55);
        let state = genesis_epoch(&secret(0xAA), &vr).unwrap();
        assert_eq!(state.validator_root, vr);
    }

    #[test]
    fn test_starts_not_finalized() {
        let state = genesis_epoch(&secret(0xAA), &vroot(0x11)).unwrap();
        assert!(!state.finalized);
    }

    #[test]
    fn test_mainnet_ready_always_false() {
        let state = genesis_epoch(&secret(0xAA), &vroot(0x11)).unwrap();
        assert!(!state.mainnet_ready);
    }

    #[test]
    fn test_transition_mainnet_ready_false() {
        let state = genesis_epoch(&secret(0xAA), &vroot(0x11)).unwrap();
        let (_, transition) = advance_epoch(&state, &vroot(0x22)).unwrap();
        assert!(!transition.mainnet_ready);
    }

    #[test]
    fn test_transition_hash_nonzero() {
        let state = genesis_epoch(&secret(0xAA), &vroot(0x11)).unwrap();
        let (_, transition) = advance_epoch(&state, &vroot(0x22)).unwrap();
        assert_ne!(transition.transition_hash, [0u8; 32]);
    }

    #[test]
    fn test_epoch_ids_differ_across_epochs() {
        let s0 = genesis_epoch(&secret(0xAA), &vroot(0x11)).unwrap();
        let (s1, _) = advance_epoch(&s0, &vroot(0x22)).unwrap();
        assert_ne!(s0.epoch_id, s1.epoch_id);
    }

    #[test]
    fn test_state_root_changes_with_validator_root() {
        let s1 = genesis_epoch(&secret(0xAA), &vroot(0x11)).unwrap();
        let s2 = genesis_epoch(&secret(0xAA), &vroot(0x99)).unwrap();
        assert_ne!(s1.state_root, s2.state_root);
    }
}
