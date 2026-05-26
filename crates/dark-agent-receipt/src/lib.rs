use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentAction {
    pub agent_id: [u8; 32],
    pub action_type: u8,
    pub payload_hash: [u8; 32],
    pub executed_at_unix: i64,
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionReceipt {
    pub action_hash: [u8; 32],
    pub agent_id: [u8; 32],
    pub prev_action_hash: [u8; 32],
    pub receipt_chain_hash: [u8; 32],
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum AgentError {
    AgentSecretZero,
    EmptyPayload,
}

pub fn create_action(
    agent_secret: &[u8; 32],
    action_type: u8,
    payload: &[u8],
    executed_at_unix: i64,
) -> Result<AgentAction, AgentError> {
    if agent_secret == &[0u8; 32] {
        return Err(AgentError::AgentSecretZero);
    }
    if payload.is_empty() {
        return Err(AgentError::EmptyPayload);
    }

    // agent_id = SHA256("agent-id-v1" || agent_secret)
    let mut h = Sha256::new();
    h.update(b"agent-id-v1");
    h.update(agent_secret);
    let agent_id: [u8; 32] = h.finalize().into();

    // payload_hash = SHA256("action-payload-v1" || payload)
    let mut h2 = Sha256::new();
    h2.update(b"action-payload-v1");
    h2.update(payload);
    let payload_hash: [u8; 32] = h2.finalize().into();

    Ok(AgentAction {
        agent_id,
        action_type,
        payload_hash,
        executed_at_unix,
        mainnet_ready: false,
    })
}

pub fn record_action(action: &AgentAction, prev_receipt_hash: &[u8; 32]) -> ActionReceipt {
    // action_hash = SHA256("agent-action-v1" || agent_id || [action_type] || payload_hash || executed_at_le)
    let mut h = Sha256::new();
    h.update(b"agent-action-v1");
    h.update(action.agent_id);
    h.update([action.action_type]);
    h.update(action.payload_hash);
    h.update(action.executed_at_unix.to_le_bytes());
    let action_hash: [u8; 32] = h.finalize().into();

    // receipt_chain_hash = SHA256("action-chain-v1" || prev_action_hash || action_hash)
    let mut h2 = Sha256::new();
    h2.update(b"action-chain-v1");
    h2.update(prev_receipt_hash);
    h2.update(action_hash);
    let receipt_chain_hash: [u8; 32] = h2.finalize().into();

    ActionReceipt {
        action_hash,
        agent_id: action.agent_id,
        prev_action_hash: *prev_receipt_hash,
        receipt_chain_hash,
        mainnet_ready: false,
    }
}

pub fn verify_receipt_chain(
    receipt: &ActionReceipt,
    action: &AgentAction,
    prev_receipt_hash: &[u8; 32],
) -> bool {
    // recompute action_hash
    let mut h = Sha256::new();
    h.update(b"agent-action-v1");
    h.update(action.agent_id);
    h.update([action.action_type]);
    h.update(action.payload_hash);
    h.update(action.executed_at_unix.to_le_bytes());
    let action_hash: [u8; 32] = h.finalize().into();

    if action_hash != receipt.action_hash {
        return false;
    }

    // recompute receipt_chain_hash
    let mut h2 = Sha256::new();
    h2.update(b"action-chain-v1");
    h2.update(prev_receipt_hash);
    h2.update(action_hash);
    let chain_hash: [u8; 32] = h2.finalize().into();

    chain_hash == receipt.receipt_chain_hash
}

pub fn action_public_record(receipt: &ActionReceipt) -> String {
    let ah_hex: String = receipt
        .action_hash
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect();
    let pah_hex: String = receipt
        .prev_action_hash
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect();
    let rch_hex: String = receipt
        .receipt_chain_hash
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect();
    serde_json::json!({
        "action_hash": ah_hex,
        "prev_action_hash": pah_hex,
        "receipt_chain_hash": rch_hex,
        "mainnet_ready": receipt.mainnet_ready,
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn secret() -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = 0xDE;
        s[1] = 0xAD;
        s
    }

    fn prev_hash() -> [u8; 32] {
        let mut h = [0u8; 32];
        h[0] = 0xFF;
        h
    }

    #[test]
    fn test_create_and_record() {
        let action = create_action(&secret(), 1, b"transfer 100 SOL", 1_700_000_000).unwrap();
        let receipt = record_action(&action, &prev_hash());
        assert_eq!(receipt.agent_id, action.agent_id);
        assert!(!receipt.mainnet_ready);
        assert!(!action.mainnet_ready);
    }

    #[test]
    fn test_chain_hash_chains_correctly() {
        let action1 = create_action(&secret(), 1, b"action one", 1_000).unwrap();
        let genesis = [0u8; 32];
        let r1 = record_action(&action1, &genesis);

        let action2 = create_action(&secret(), 2, b"action two", 2_000).unwrap();
        let r2 = record_action(&action2, &r1.receipt_chain_hash);

        // r2's prev_action_hash should be r1's chain hash
        assert_eq!(r2.prev_action_hash, r1.receipt_chain_hash);
        assert_ne!(r1.receipt_chain_hash, r2.receipt_chain_hash);
    }

    #[test]
    fn test_verify_passes() {
        let action = create_action(&secret(), 5, b"payload bytes", 9_999).unwrap();
        let receipt = record_action(&action, &prev_hash());
        assert!(verify_receipt_chain(&receipt, &action, &prev_hash()));
    }

    #[test]
    fn test_zero_secret_rejected() {
        let err = create_action(&[0u8; 32], 1, b"payload", 0).unwrap_err();
        assert_eq!(err, AgentError::AgentSecretZero);
    }

    #[test]
    fn test_empty_payload_rejected() {
        let err = create_action(&secret(), 1, b"", 0).unwrap_err();
        assert_eq!(err, AgentError::EmptyPayload);
    }

    #[test]
    fn test_public_record_hides_agent_id() {
        let action = create_action(&secret(), 3, b"some payload", 42).unwrap();
        let receipt = record_action(&action, &prev_hash());
        let json_str = action_public_record(&receipt);
        assert!(!json_str.contains("agent_id"));
        let v: serde_json::Value = serde_json::from_str(&json_str).unwrap();
        assert!(v["action_hash"].is_string());
        assert!(v["prev_action_hash"].is_string());
        assert!(v["receipt_chain_hash"].is_string());
        assert_eq!(v["mainnet_ready"], false);
        assert!(!v["mainnet_ready"].as_bool().unwrap());
    }
}
