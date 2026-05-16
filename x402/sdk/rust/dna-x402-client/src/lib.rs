use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

#[derive(Debug)]
pub enum VerifyError {
    Json(String),
    MissingField(&'static str),
    InvalidHex,
    InvalidBase58,
    InvalidKey,
    InvalidSignature,
}

fn sha256_hex(input: &str) -> String {
    let digest = Sha256::digest(input.as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn hex_to_32(value: &str) -> Result<[u8; 32], VerifyError> {
    if value.len() != 64 {
        return Err(VerifyError::InvalidHex);
    }
    let mut out = [0u8; 32];
    for (i, chunk) in value.as_bytes().chunks(2).enumerate() {
        let part = std::str::from_utf8(chunk).map_err(|_| VerifyError::InvalidHex)?;
        out[i] = u8::from_str_radix(part, 16).map_err(|_| VerifyError::InvalidHex)?;
    }
    Ok(out)
}

fn string_field<'a>(value: &'a Value, key: &'static str) -> Result<&'a str, VerifyError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or(VerifyError::MissingField(key))
}

fn receipt_hash_input(receipt: &Value) -> Result<String, VerifyError> {
    let mut root = Map::new();
    root.insert("prevHash".to_string(), Value::String(string_field(receipt, "prevHash")?.to_string()));
    root.insert(
        "payload".to_string(),
        receipt
            .get("payload")
            .ok_or(VerifyError::MissingField("payload"))?
            .clone(),
    );
    serde_json::to_string(&Value::Object(root)).map_err(|error| VerifyError::Json(error.to_string()))
}

pub fn verify_signed_receipt_value(receipt: &Value) -> Result<bool, VerifyError> {
    let expected_hash = sha256_hex(&receipt_hash_input(receipt)?);
    if expected_hash != string_field(receipt, "receiptHash")? {
        return Ok(false);
    }

    let public_key_bytes = bs58::decode(string_field(receipt, "signerPublicKey")?)
        .into_vec()
        .map_err(|_| VerifyError::InvalidBase58)?;
    let public_key_array: [u8; 32] = public_key_bytes
        .as_slice()
        .try_into()
        .map_err(|_| VerifyError::InvalidKey)?;
    let verifying_key = VerifyingKey::from_bytes(&public_key_array).map_err(|_| VerifyError::InvalidKey)?;

    let signature_bytes = bs58::decode(string_field(receipt, "signature")?)
        .into_vec()
        .map_err(|_| VerifyError::InvalidBase58)?;
    let signature = Signature::from_slice(&signature_bytes).map_err(|_| VerifyError::InvalidSignature)?;
    let message = hex_to_32(&expected_hash)?;

    Ok(verifying_key.verify(&message, &signature).is_ok())
}

pub fn verify_signed_receipt_json(raw: &str) -> Result<bool, VerifyError> {
    let receipt: Value = serde_json::from_str(raw).map_err(|error| VerifyError::Json(error.to_string()))?;
    verify_signed_receipt_value(&receipt)
}

pub fn verify_receipt_binding(
    receipt: &Value,
    request_digest: &str,
    response_digest: &str,
    recipient: Option<&str>,
    mint: Option<&str>,
    total_atomic: Option<&str>,
) -> bool {
    let Some(payload) = receipt.get("payload") else {
        return false;
    };
    if payload.get("requestDigest").and_then(Value::as_str) != Some(request_digest) {
        return false;
    }
    if payload.get("responseDigest").and_then(Value::as_str) != Some(response_digest) {
        return false;
    }
    if let Some(recipient) = recipient {
        if payload.get("recipient").and_then(Value::as_str) != Some(recipient) {
            return false;
        }
    }
    if let Some(mint) = mint {
        if payload.get("mint").and_then(Value::as_str) != Some(mint) {
            return false;
        }
    }
    if let Some(total_atomic) = total_atomic {
        if payload.get("totalAtomic").and_then(Value::as_str) != Some(total_atomic) {
            return false;
        }
    }
    true
}

fn detached_payload_hash(payload: &Value) -> Result<[u8; 32], VerifyError> {
    let encoded = serde_json::to_string(payload).map_err(|error| VerifyError::Json(error.to_string()))?;
    let digest = Sha256::digest(encoded.as_bytes());
    Ok(digest.into())
}

pub fn verify_detached_signature(
    payload: &Value,
    signature_base58: &str,
    signer_public_key_base58: &str,
) -> Result<bool, VerifyError> {
    let public_key_bytes = bs58::decode(signer_public_key_base58)
        .into_vec()
        .map_err(|_| VerifyError::InvalidBase58)?;
    let public_key_array: [u8; 32] = public_key_bytes
        .as_slice()
        .try_into()
        .map_err(|_| VerifyError::InvalidKey)?;
    let verifying_key = VerifyingKey::from_bytes(&public_key_array).map_err(|_| VerifyError::InvalidKey)?;
    let signature_bytes = bs58::decode(signature_base58)
        .into_vec()
        .map_err(|_| VerifyError::InvalidBase58)?;
    let signature = Signature::from_slice(&signature_bytes).map_err(|_| VerifyError::InvalidSignature)?;
    let payload_hash = detached_payload_hash(payload)?;
    Ok(verifying_key.verify(&payload_hash, &signature).is_ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_tampered_receipt() {
        let raw = r#"{
          "payload":{"receiptId":"0","quoteId":"quote"},
          "prevHash":"0000000000000000000000000000000000000000000000000000000000000000",
          "receiptHash":"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
          "signerPublicKey":"11111111111111111111111111111111",
          "signature":"1111111111111111111111111111111111111111111111111111111111111111"
        }"#;
        assert!(!verify_signed_receipt_json(raw).unwrap_or(false));
    }
}
