use sha2::{Digest, Sha256};

#[derive(Debug, Clone)]
pub struct MultisigSetup {
    pub setup_id: [u8; 32],
    pub signer_root: [u8; 32],
    pub threshold: u32,
    pub signer_count: u32,
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone)]
pub struct MultisigApproval {
    pub approval_id: [u8; 32],
    pub message_hash: [u8; 32],
    pub aggregate_hash: [u8; 32],
    pub approvals_collected: u32,
    pub approved: bool,
    pub mainnet_ready: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub enum MultisigError {
    ZeroThreshold,
    ThresholdExceedsSigners,
    InsufficientApprovals,
    DuplicateSigner,
}

fn sha256_tagged(tag: &[u8], data: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(tag);
    h.update(data);
    h.finalize().into()
}

fn xor_fold(hashes: &[[u8; 32]]) -> [u8; 32] {
    let mut acc = [0u8; 32];
    for h in hashes {
        for i in 0..32 {
            acc[i] ^= h[i];
        }
    }
    acc
}

pub fn new_multisig(
    signer_secrets: &[&[u8; 32]],
    threshold: u32,
) -> Result<MultisigSetup, MultisigError> {
    if threshold == 0 {
        return Err(MultisigError::ZeroThreshold);
    }
    if threshold > signer_secrets.len() as u32 {
        return Err(MultisigError::ThresholdExceedsSigners);
    }
    // compute signer hashes and check for duplicates
    let mut signer_hashes: Vec<[u8; 32]> = Vec::with_capacity(signer_secrets.len());
    for s in signer_secrets {
        let sh = sha256_tagged(b"msig-signer-v1", *s);
        if signer_hashes.contains(&sh) {
            return Err(MultisigError::DuplicateSigner);
        }
        signer_hashes.push(sh);
    }
    let count = signer_secrets.len() as u32;
    let xored = xor_fold(&signer_hashes);
    let signer_root = {
        let mut h = Sha256::new();
        h.update(b"msig-sroot-v1");
        h.update(xored);
        h.update(count.to_le_bytes());
        h.finalize().into()
    };
    let setup_id = {
        let mut h = Sha256::new();
        h.update(b"msig-setup-v1");
        h.update(signer_root);
        h.update(threshold.to_le_bytes());
        h.finalize().into()
    };
    Ok(MultisigSetup {
        setup_id,
        signer_root,
        threshold,
        signer_count: count,
        mainnet_ready: false,
    })
}

pub fn approve(
    setup: &MultisigSetup,
    approver_secrets: &[&[u8; 32]],
    message: &[u8],
) -> Result<MultisigApproval, MultisigError> {
    if approver_secrets.len() < setup.threshold as usize {
        return Err(MultisigError::InsufficientApprovals);
    }
    let message_hash = sha256_tagged(b"msig-msg-v1", message);
    let sig_hashes: Vec<[u8; 32]> = approver_secrets
        .iter()
        .map(|s| {
            let sh = sha256_tagged(b"msig-signer-v1", *s);
            let mut h = Sha256::new();
            h.update(b"msig-sig-v1");
            h.update(sh);
            h.update(message_hash);
            h.finalize().into()
        })
        .collect();
    let xored = xor_fold(&sig_hashes);
    let count = approver_secrets.len() as u32;
    let aggregate_hash = {
        let mut h = Sha256::new();
        h.update(b"msig-agg-v1");
        h.update(xored);
        h.update(count.to_le_bytes());
        h.finalize().into()
    };
    let approval_id = {
        let mut h = Sha256::new();
        h.update(b"msig-approval-v1");
        h.update(setup.setup_id);
        h.update(aggregate_hash);
        h.finalize().into()
    };
    Ok(MultisigApproval {
        approval_id,
        message_hash,
        aggregate_hash,
        approvals_collected: count,
        approved: true,
        mainnet_ready: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(seed: u8) -> [u8; 32] {
        let mut b = [0u8; 32];
        b[0] = seed;
        b
    }

    #[test]
    fn new_multisig_mainnet_ready_false() {
        let s1 = s(0xAA);
        let s2 = s(0xBB);
        let s3 = s(0xCC);
        let setup = new_multisig(&[&s1, &s2, &s3], 2).unwrap();
        assert!(!setup.mainnet_ready);
        assert_eq!(setup.threshold, 2);
        assert_eq!(setup.signer_count, 3);
        assert_ne!(setup.setup_id, [0u8; 32]);
    }

    #[test]
    fn approve_with_threshold_signers_succeeds() {
        let s1 = s(0xAA);
        let s2 = s(0xBB);
        let s3 = s(0xCC);
        let setup = new_multisig(&[&s1, &s2, &s3], 2).unwrap();
        let approval = approve(&setup, &[&s1, &s2], b"test_message").unwrap();
        assert!(approval.approved);
        assert_eq!(approval.approvals_collected, 2);
        assert_ne!(approval.aggregate_hash, [0u8; 32]);
    }

    #[test]
    fn insufficient_approvals_is_rejected() {
        let s1 = s(0xAA);
        let s2 = s(0xBB);
        let s3 = s(0xCC);
        let setup = new_multisig(&[&s1, &s2, &s3], 2).unwrap();
        let err = approve(&setup, &[&s1], b"test_message").unwrap_err();
        assert_eq!(err, MultisigError::InsufficientApprovals);
    }

    #[test]
    fn zero_threshold_is_rejected() {
        let s1 = s(0xAA);
        let s2 = s(0xBB);
        let err = new_multisig(&[&s1, &s2], 0).unwrap_err();
        assert_eq!(err, MultisigError::ZeroThreshold);
    }

    #[test]
    fn threshold_exceeds_signers_is_rejected() {
        let s1 = s(0xAA);
        let s2 = s(0xBB);
        let err = new_multisig(&[&s1, &s2], 3).unwrap_err();
        assert_eq!(err, MultisigError::ThresholdExceedsSigners);
    }

    #[test]
    fn aggregate_hash_is_non_zero() {
        let s1 = s(0xAA);
        let s2 = s(0xBB);
        let setup = new_multisig(&[&s1, &s2], 2).unwrap();
        let approval = approve(&setup, &[&s1, &s2], b"test_message").unwrap();
        assert_ne!(approval.aggregate_hash, [0u8; 32]);
    }
}
