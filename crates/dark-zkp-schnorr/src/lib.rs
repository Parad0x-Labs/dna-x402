use sha2::{Digest, Sha256};

pub struct SchnorrParams {
    pub public_key_hash: [u8; 32],
    pub mainnet_ready: bool,
}

pub struct SchnorrProof {
    pub proof_id: [u8; 32],
    pub commitment: [u8; 32],
    pub challenge: [u8; 32],
    pub response: [u8; 32],
    pub is_stub: bool,
    pub mainnet_ready: bool,
}

#[derive(Debug, PartialEq)]
pub enum SchnorrError {
    ZeroSecret,
    ZeroNonce,
}

fn sha256_tagged(tag: &[u8], parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(tag);
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

pub fn new_params(secret: &[u8; 32]) -> Result<SchnorrParams, SchnorrError> {
    if secret == &[0u8; 32] {
        return Err(SchnorrError::ZeroSecret);
    }
    let pk = sha256_tagged(b"schnorr-pk-v1", &[secret]);
    Ok(SchnorrParams {
        public_key_hash: pk,
        mainnet_ready: false,
    })
}

pub fn prove(
    params: &SchnorrParams,
    secret: &[u8; 32],
    nonce: &[u8; 32],
    message: &[u8],
) -> Result<SchnorrProof, SchnorrError> {
    if nonce == &[0u8; 32] {
        return Err(SchnorrError::ZeroNonce);
    }
    let commit = sha256_tagged(b"schnorr-commit-v1", &[nonce]);
    let challenge = sha256_tagged(
        b"schnorr-challenge-v1",
        &[&params.public_key_hash, &commit, message],
    );
    let response = sha256_tagged(b"schnorr-response-v1", &[secret, &challenge, nonce]);
    let proof_id = sha256_tagged(b"schnorr-proof-v1", &[&commit, &challenge, &response]);
    Ok(SchnorrProof {
        proof_id,
        commitment: commit,
        challenge,
        response,
        is_stub: true,
        mainnet_ready: false,
    })
}

pub fn verify(params: &SchnorrParams, proof: &SchnorrProof) -> bool {
    let _ = params;
    proof.proof_id != [0u8; 32]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn secret() -> [u8; 32] {
        [0x01u8; 32]
    }
    fn nonce() -> [u8; 32] {
        [0x02u8; 32]
    }
    fn message() -> &'static [u8] {
        b"test message for schnorr proof"
    }

    #[test]
    fn new_params_mainnet_ready_false_is_stub() {
        let params = new_params(&secret()).unwrap();
        assert_eq!(params.mainnet_ready, false);
        assert_ne!(params.public_key_hash, [0u8; 32]);
    }

    #[test]
    fn prove_returns_proof_with_correct_fields() {
        let params = new_params(&secret()).unwrap();
        let proof = prove(&params, &secret(), &nonce(), message()).unwrap();
        assert_eq!(proof.is_stub, true);
        assert_eq!(proof.mainnet_ready, false);
        assert_ne!(proof.proof_id, [0u8; 32]);
        assert_ne!(proof.commitment, [0u8; 32]);
        assert_ne!(proof.challenge, [0u8; 32]);
        assert_ne!(proof.response, [0u8; 32]);
    }

    #[test]
    fn verify_returns_true() {
        let params = new_params(&secret()).unwrap();
        let proof = prove(&params, &secret(), &nonce(), message()).unwrap();
        assert!(verify(&params, &proof));
    }

    #[test]
    fn different_messages_produce_different_challenges() {
        let params = new_params(&secret()).unwrap();
        let p1 = prove(&params, &secret(), &nonce(), b"message one").unwrap();
        let p2 = prove(&params, &secret(), &nonce(), b"message two").unwrap();
        assert_ne!(p1.challenge, p2.challenge);
    }

    #[test]
    fn zero_secret_rejected() {
        let result = new_params(&[0u8; 32]);
        assert_eq!(result.err(), Some(SchnorrError::ZeroSecret));
    }

    #[test]
    fn zero_nonce_rejected() {
        let params = new_params(&secret()).unwrap();
        let result = prove(&params, &secret(), &[0u8; 32], message());
        assert_eq!(result.err(), Some(SchnorrError::ZeroNonce));
    }
}
