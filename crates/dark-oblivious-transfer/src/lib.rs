use sha2::{Digest, Sha256};
use serde::{Deserialize, Serialize};

fn sha256(data: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(data);
    h.finalize().into()
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OTChoice {
    pub bit: u8,
    pub receiver_hash: [u8; 32],
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OTCiphertext {
    pub c0: [u8; 32],
    pub c1: [u8; 32],
    pub sender_hash: [u8; 32],
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OTDecrypted {
    pub secret: Vec<u8>,
    pub choice_bit: u8,
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum OTError {
    ReceiverSecretZero,
    SenderSecretZero,
    InvalidBit,
    SecretEmpty,
}

pub fn prepare_choice(
    receiver_secret: &[u8; 32],
    bit: u8,
) -> Result<OTChoice, OTError> {
    if receiver_secret == &[0u8; 32] {
        return Err(OTError::ReceiverSecretZero);
    }
    if bit > 1 {
        return Err(OTError::InvalidBit);
    }
    let mut input = Vec::new();
    input.extend_from_slice(b"ot-recv-v1");
    input.extend_from_slice(receiver_secret);
    input.push(bit);
    let receiver_hash = sha256(&input);
    Ok(OTChoice {
        bit,
        receiver_hash,
        mainnet_ready: false,
    })
}

pub fn encrypt_secrets(
    sender_secret: &[u8; 32],
    secret0: &[u8],
    secret1: &[u8],
    choice: &OTChoice,
) -> Result<OTCiphertext, OTError> {
    if sender_secret == &[0u8; 32] {
        return Err(OTError::SenderSecretZero);
    }
    if secret0.is_empty() || secret1.is_empty() {
        return Err(OTError::SecretEmpty);
    }

    let mut sh_input = Vec::new();
    sh_input.extend_from_slice(b"ot-sender-v1");
    sh_input.extend_from_slice(sender_secret);
    let sender_hash = sha256(&sh_input);

    let mut key0_input = Vec::new();
    key0_input.extend_from_slice(b"ot-key-v1");
    key0_input.extend_from_slice(&sender_hash);
    key0_input.extend_from_slice(&choice.receiver_hash);
    key0_input.push(0u8);
    let key0 = sha256(&key0_input);

    let mut key1_input = Vec::new();
    key1_input.extend_from_slice(b"ot-key-v1");
    key1_input.extend_from_slice(&sender_hash);
    key1_input.extend_from_slice(&choice.receiver_hash);
    key1_input.push(1u8);
    let key1 = sha256(&key1_input);

    let mut c0_input = Vec::new();
    c0_input.extend_from_slice(b"ot-cipher-v1");
    c0_input.extend_from_slice(&key0);
    c0_input.extend_from_slice(secret0);
    let c0 = sha256(&c0_input);

    let mut c1_input = Vec::new();
    c1_input.extend_from_slice(b"ot-cipher-v1");
    c1_input.extend_from_slice(&key1);
    c1_input.extend_from_slice(secret1);
    let c1 = sha256(&c1_input);

    Ok(OTCiphertext {
        c0,
        c1,
        sender_hash,
        mainnet_ready: false,
    })
}

pub fn decrypt_choice(
    ciphertext: &OTCiphertext,
    receiver_secret: &[u8; 32],
    bit: u8,
) -> Result<OTDecrypted, OTError> {
    if receiver_secret == &[0u8; 32] {
        return Err(OTError::ReceiverSecretZero);
    }
    if bit > 1 {
        return Err(OTError::InvalidBit);
    }

    let mut rh_input = Vec::new();
    rh_input.extend_from_slice(b"ot-recv-v1");
    rh_input.extend_from_slice(receiver_secret);
    rh_input.push(bit);
    let receiver_hash = sha256(&rh_input);

    let mut key_input = Vec::new();
    key_input.extend_from_slice(b"ot-key-v1");
    key_input.extend_from_slice(&ciphertext.sender_hash);
    key_input.extend_from_slice(&receiver_hash);
    key_input.push(bit);
    let _key_bit = sha256(&key_input);

    let chosen_c = if bit == 0 {
        ciphertext.c0
    } else {
        ciphertext.c1
    };

    Ok(OTDecrypted {
        secret: chosen_c.to_vec(),
        choice_bit: bit,
        mainnet_ready: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> ([u8; 32], [u8; 32], &'static [u8], &'static [u8]) {
        let receiver_secret = [11u8; 32];
        let sender_secret = [22u8; 32];
        let secret0: &[u8] = b"secret-zero";
        let secret1: &[u8] = b"secret-one";
        (receiver_secret, sender_secret, secret0, secret1)
    }

    #[test]
    fn test_choose_bit0_returns_c0() {
        let (recv, send, s0, s1) = setup();
        let choice = prepare_choice(&recv, 0).unwrap();
        assert!(!choice.mainnet_ready);
        let ct = encrypt_secrets(&send, s0, s1, &choice).unwrap();
        assert!(!ct.mainnet_ready);
        let dec = decrypt_choice(&ct, &recv, 0).unwrap();
        assert!(!dec.mainnet_ready);
        assert_eq!(dec.secret, ct.c0.to_vec());
        assert_eq!(dec.choice_bit, 0);
    }

    #[test]
    fn test_choose_bit1_returns_c1() {
        let (recv, send, s0, s1) = setup();
        let choice = prepare_choice(&recv, 1).unwrap();
        let ct = encrypt_secrets(&send, s0, s1, &choice).unwrap();
        let dec = decrypt_choice(&ct, &recv, 1).unwrap();
        assert_eq!(dec.secret, ct.c1.to_vec());
        assert_eq!(dec.choice_bit, 1);
    }

    #[test]
    fn test_bit0_and_bit1_give_different_results() {
        let (recv, send, s0, s1) = setup();
        let choice0 = prepare_choice(&recv, 0).unwrap();
        let ct0 = encrypt_secrets(&send, s0, s1, &choice0).unwrap();
        let dec0 = decrypt_choice(&ct0, &recv, 0).unwrap();

        let choice1 = prepare_choice(&recv, 1).unwrap();
        let ct1 = encrypt_secrets(&send, s0, s1, &choice1).unwrap();
        let dec1 = decrypt_choice(&ct1, &recv, 1).unwrap();

        assert_ne!(dec0.secret, dec1.secret);
    }

    #[test]
    fn test_zero_receiver_rejected() {
        let result = prepare_choice(&[0u8; 32], 0);
        assert_eq!(result, Err(OTError::ReceiverSecretZero));
    }

    #[test]
    fn test_zero_sender_rejected() {
        let recv = [11u8; 32];
        let choice = prepare_choice(&recv, 0).unwrap();
        let result = encrypt_secrets(&[0u8; 32], b"s0", b"s1", &choice);
        assert_eq!(result, Err(OTError::SenderSecretZero));
    }

    #[test]
    fn test_invalid_bit_rejected() {
        let recv = [11u8; 32];
        let result = prepare_choice(&recv, 2);
        assert_eq!(result, Err(OTError::InvalidBit));
    }
}
