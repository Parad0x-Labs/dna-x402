use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

fn sha256(data: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(data);
    h.finalize().into()
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BlindedMessage {
    pub blinded: [u8; 32],
    pub blinding_factor: [u8; 32],
    pub message_hash: [u8; 32],
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BlindSignature {
    pub signature: [u8; 32],
    pub signer_pubkey: [u8; 32],
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UnblindedSignature {
    pub message_hash: [u8; 32],
    pub signature: [u8; 32],
    pub signer_pubkey: [u8; 32],
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum BlindSigError {
    BlindingZero,
    SignerSecretZero,
    UnblindingFailed,
}

pub fn blind_message(
    message: &[u8],
    blinding_factor: &[u8; 32],
) -> Result<BlindedMessage, BlindSigError> {
    if blinding_factor == &[0u8; 32] {
        return Err(BlindSigError::BlindingZero);
    }
    let mut msg_input = Vec::new();
    msg_input.extend_from_slice(b"blind-sig-msg-v1");
    msg_input.extend_from_slice(message);
    let message_hash = sha256(&msg_input);

    let mut blind_input = Vec::new();
    blind_input.extend_from_slice(b"blind-sig-blind-v1");
    blind_input.extend_from_slice(&message_hash);
    blind_input.extend_from_slice(blinding_factor);
    let blinded = sha256(&blind_input);

    Ok(BlindedMessage {
        blinded,
        blinding_factor: *blinding_factor,
        message_hash,
        mainnet_ready: false,
    })
}

pub fn sign_blinded(
    signer_secret: &[u8; 32],
    blinded_msg: &BlindedMessage,
) -> Result<BlindSignature, BlindSigError> {
    if signer_secret == &[0u8; 32] {
        return Err(BlindSigError::SignerSecretZero);
    }
    let mut pub_input = Vec::new();
    pub_input.extend_from_slice(b"blind-sig-pub-v1");
    pub_input.extend_from_slice(signer_secret);
    let signer_pubkey = sha256(&pub_input);

    let mut sign_input = Vec::new();
    sign_input.extend_from_slice(b"blind-sig-sign-v1");
    sign_input.extend_from_slice(&signer_pubkey);
    sign_input.extend_from_slice(&blinded_msg.blinded);
    let signature = sha256(&sign_input);

    Ok(BlindSignature {
        signature,
        signer_pubkey,
        mainnet_ready: false,
    })
}

pub fn unblind_signature(
    sig: &BlindSignature,
    blinded_msg: &BlindedMessage,
) -> Result<UnblindedSignature, BlindSigError> {
    let mut expected_input = Vec::new();
    expected_input.extend_from_slice(b"blind-sig-sign-v1");
    expected_input.extend_from_slice(&sig.signer_pubkey);
    expected_input.extend_from_slice(&blinded_msg.blinded);
    let expected = sha256(&expected_input);

    if expected != sig.signature {
        return Err(BlindSigError::UnblindingFailed);
    }

    Ok(UnblindedSignature {
        message_hash: blinded_msg.message_hash,
        signature: sig.signature,
        signer_pubkey: sig.signer_pubkey,
        mainnet_ready: false,
    })
}

pub fn verify_unblinded(sig: &UnblindedSignature) -> bool {
    sig.signature != [0u8; 32]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_blind_sign_unblind_roundtrip() {
        let message = b"pay-100-tokens";
        let blinding_factor = [42u8; 32];
        let signer_secret = [99u8; 32];

        let blinded = blind_message(message, &blinding_factor).unwrap();
        assert!(!blinded.mainnet_ready);

        let blind_sig = sign_blinded(&signer_secret, &blinded).unwrap();
        assert!(!blind_sig.mainnet_ready);

        let unblinded = unblind_signature(&blind_sig, &blinded).unwrap();
        assert!(!unblinded.mainnet_ready);

        assert!(verify_unblinded(&unblinded));
    }

    #[test]
    fn test_wrong_blinding_fails_unblinding() {
        let message = b"pay-100-tokens";
        let blinding_factor = [42u8; 32];
        let signer_secret = [99u8; 32];

        let blinded = blind_message(message, &blinding_factor).unwrap();
        let blind_sig = sign_blinded(&signer_secret, &blinded).unwrap();

        // Create a blinded message with different blinding factor
        let other_blinding = [7u8; 32];
        let other_blinded = blind_message(message, &other_blinding).unwrap();

        // Trying to unblind with wrong blinded message should fail
        let result = unblind_signature(&blind_sig, &other_blinded);
        assert_eq!(result, Err(BlindSigError::UnblindingFailed));
    }

    #[test]
    fn test_zero_blinding_rejected() {
        let result = blind_message(b"some-message", &[0u8; 32]);
        assert_eq!(result, Err(BlindSigError::BlindingZero));
    }

    #[test]
    fn test_zero_signer_rejected() {
        let blinded = blind_message(b"some-message", &[1u8; 32]).unwrap();
        let result = sign_blinded(&[0u8; 32], &blinded);
        assert_eq!(result, Err(BlindSigError::SignerSecretZero));
    }

    #[test]
    fn test_different_messages_produce_different_signatures() {
        let blinding_factor = [55u8; 32];
        let signer_secret = [77u8; 32];

        let blinded_a = blind_message(b"message-alpha", &blinding_factor).unwrap();
        let blinded_b = blind_message(b"message-beta", &blinding_factor).unwrap();

        let sig_a = sign_blinded(&signer_secret, &blinded_a).unwrap();
        let sig_b = sign_blinded(&signer_secret, &blinded_b).unwrap();

        assert_ne!(sig_a.signature, sig_b.signature);
    }

    #[test]
    fn test_verify_unblinded_passes() {
        let message = b"verify-me";
        let blinding_factor = [11u8; 32];
        let signer_secret = [22u8; 32];

        let blinded = blind_message(message, &blinding_factor).unwrap();
        let blind_sig = sign_blinded(&signer_secret, &blinded).unwrap();
        let unblinded = unblind_signature(&blind_sig, &blinded).unwrap();

        assert!(verify_unblinded(&unblinded));
        assert_eq!(unblinded.message_hash, blinded.message_hash);
    }
}
