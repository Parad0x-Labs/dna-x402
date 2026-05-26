use sha2::{Digest, Sha256};

pub const MAX_RELAY_HOPS: u8 = 10;

#[derive(Debug, Clone, PartialEq)]
pub struct RelayAttestation {
    /// SHA256("relay-msg-v1" || message_bytes)
    pub message_hash: [u8; 32],
    /// SHA256("relay-node-v1" || node_secret)
    pub node_pubkey: [u8; 32],
    /// SHA256("relay-attest-v1" || node_pubkey || message_hash || prev_hash || hop_le)
    pub attestation: [u8; 32],
    pub hop: u8,
    /// SHA256 of previous relay attestation (or [0;32] for first hop)
    pub prev_hash: [u8; 32],
    pub relayed_at_unix: i64,
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone)]
pub struct RelayChain {
    /// Accumulated proof: SHA256("relay-chain-v1" || XOR-fold of all attestations)
    pub chain_proof: [u8; 32],
    pub hop_count: u8,
    hops: Vec<[u8; 32]>, // attestation hashes
    mainnet_ready: bool,
}

#[derive(Debug, PartialEq)]
pub enum RelayError {
    NodeSecretZero,
    EmptyMessage,
    MaxHopsExceeded,
    HopMismatch,
}

/// Create a relay attestation for a single node forwarding a message.
///
/// Returns `RelayError::NodeSecretZero` if `node_secret` is all zeros.
/// Returns `RelayError::EmptyMessage` if `message_bytes` is empty.
/// Returns `RelayError::MaxHopsExceeded` if `hop >= MAX_RELAY_HOPS`.
pub fn create_attestation(
    node_secret: &[u8; 32],
    message_bytes: &[u8],
    prev_hash: &[u8; 32],
    hop: u8,
    relayed_at_unix: i64,
) -> Result<RelayAttestation, RelayError> {
    if node_secret == &[0u8; 32] {
        return Err(RelayError::NodeSecretZero);
    }
    if message_bytes.is_empty() {
        return Err(RelayError::EmptyMessage);
    }
    if hop >= MAX_RELAY_HOPS {
        return Err(RelayError::MaxHopsExceeded);
    }

    // node_pubkey = SHA256("relay-node-v1" || node_secret)
    let node_pubkey: [u8; 32] = {
        let mut h = Sha256::new();
        h.update(b"relay-node-v1");
        h.update(node_secret);
        h.finalize().into()
    };

    // message_hash = SHA256("relay-msg-v1" || message_bytes)
    let message_hash: [u8; 32] = {
        let mut h = Sha256::new();
        h.update(b"relay-msg-v1");
        h.update(message_bytes);
        h.finalize().into()
    };

    // attestation = SHA256("relay-attest-v1" || node_pubkey || message_hash || prev_hash || [hop])
    let attestation: [u8; 32] = {
        let mut h = Sha256::new();
        h.update(b"relay-attest-v1");
        h.update(&node_pubkey);
        h.update(&message_hash);
        h.update(prev_hash);
        h.update(&[hop]);
        h.finalize().into()
    };

    Ok(RelayAttestation {
        message_hash,
        node_pubkey,
        attestation,
        hop,
        prev_hash: *prev_hash,
        relayed_at_unix,
        mainnet_ready: false,
    })
}

/// Create a new empty relay chain.
pub fn new_relay_chain() -> RelayChain {
    RelayChain {
        chain_proof: [0u8; 32],
        hop_count: 0,
        hops: vec![],
        mainnet_ready: false,
    }
}

/// Add a relay attestation to the chain.
///
/// Returns `RelayError::MaxHopsExceeded` if `chain.hop_count >= MAX_RELAY_HOPS`.
/// Returns `RelayError::HopMismatch` if `attest.hop != chain.hop_count`.
pub fn add_attestation(
    chain: &mut RelayChain,
    attest: &RelayAttestation,
) -> Result<(), RelayError> {
    if chain.hop_count >= MAX_RELAY_HOPS {
        return Err(RelayError::MaxHopsExceeded);
    }
    if attest.hop != chain.hop_count {
        return Err(RelayError::HopMismatch);
    }

    // XOR attestation hash into accumulator (rebuilt from stored hops + new entry)
    let mut xor_accumulator = [0u8; 32];
    for h in &chain.hops {
        for (a, b) in xor_accumulator.iter_mut().zip(h.iter()) {
            *a ^= b;
        }
    }
    for (a, b) in xor_accumulator.iter_mut().zip(attest.attestation.iter()) {
        *a ^= b;
    }

    // chain_proof = SHA256("relay-chain-v1" || xor_accumulator)
    let chain_proof: [u8; 32] = {
        let mut h = Sha256::new();
        h.update(b"relay-chain-v1");
        h.update(&xor_accumulator);
        h.finalize().into()
    };

    chain.chain_proof = chain_proof;
    chain.hops.push(attest.attestation);
    chain.hop_count += 1;
    chain.mainnet_ready = attest.mainnet_ready;

    Ok(())
}

/// Verify that an attestation's hash is consistent with its fields.
pub fn verify_attestation(attest: &RelayAttestation) -> bool {
    let expected: [u8; 32] = {
        let mut h = Sha256::new();
        h.update(b"relay-attest-v1");
        h.update(&attest.node_pubkey);
        h.update(&attest.message_hash);
        h.update(&attest.prev_hash);
        h.update(&[attest.hop]);
        h.finalize().into()
    };
    attest.attestation == expected
}

/// Return a JSON string suitable for public logging.
/// Contains chain_proof hex, hop_count, and mainnet_ready.
/// Does NOT include individual node identities.
pub fn chain_public_record(chain: &RelayChain) -> String {
    let proof_hex: String = chain
        .chain_proof
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect();

    serde_json::json!({
        "chain_proof": proof_hex,
        "hop_count": chain.hop_count,
        "mainnet_ready": chain.mainnet_ready,
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_secret(seed: u8) -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = seed;
        s[1] = 0xde;
        s[2] = 0xad;
        s
    }

    /// 1. Three hops all attest correctly and a chain is built successfully.
    #[test]
    fn test_relay_chain_happy_path() {
        let message = b"hello relay world";
        let mut chain = new_relay_chain();

        let mut prev_hash = [0u8; 32];

        for hop in 0..3u8 {
            let secret = make_secret(hop + 1);
            let attest = create_attestation(
                &secret,
                message,
                &prev_hash,
                hop,
                1_700_000_000 + hop as i64,
            )
            .expect("attestation should succeed");

            assert!(verify_attestation(&attest), "attestation should verify");
            prev_hash = attest.attestation;

            add_attestation(&mut chain, &attest).expect("add should succeed");
        }

        assert_eq!(chain.hop_count, 3);
        assert_ne!(chain.chain_proof, [0u8; 32]);
    }

    /// 2. Empty message is rejected with RelayError::EmptyMessage.
    #[test]
    fn test_empty_message_rejected() {
        let secret = make_secret(1);
        let prev_hash = [0u8; 32];
        let result = create_attestation(&secret, b"", &prev_hash, 0, 0);
        assert_eq!(result, Err(RelayError::EmptyMessage));
    }

    /// 3. hop=10 is rejected with RelayError::MaxHopsExceeded.
    #[test]
    fn test_max_hops_exceeded() {
        let secret = make_secret(1);
        let prev_hash = [0u8; 32];
        let result = create_attestation(&secret, b"msg", &prev_hash, MAX_RELAY_HOPS, 0);
        assert_eq!(result, Err(RelayError::MaxHopsExceeded));
    }

    /// 4. verify_attestation returns true for a freshly created attestation.
    #[test]
    fn test_verify_attestation_passes() {
        let secret = make_secret(7);
        let prev_hash = [0u8; 32];
        let attest = create_attestation(&secret, b"verify me", &prev_hash, 0, 999)
            .expect("creation should succeed");
        assert!(verify_attestation(&attest));
    }

    /// 5. chain_proof differs after each hop is added.
    #[test]
    fn test_chain_proof_changes_per_hop() {
        let message = b"proof changes";
        let mut chain = new_relay_chain();
        let mut prev_hash = [0u8; 32];
        let mut seen_proofs: Vec<[u8; 32]> = vec![];

        for hop in 0..3u8 {
            let secret = make_secret(hop + 10);
            let attest = create_attestation(&secret, message, &prev_hash, hop, hop as i64)
                .expect("creation should succeed");
            prev_hash = attest.attestation;
            add_attestation(&mut chain, &attest).expect("add should succeed");

            // Each new chain_proof must differ from all previous ones
            assert!(
                !seen_proofs.contains(&chain.chain_proof),
                "chain_proof must change on hop {}",
                hop
            );
            seen_proofs.push(chain.chain_proof);
        }
    }

    /// 6. chain_public_record does not leak individual node_pubkey values.
    #[test]
    fn test_public_record_hides_nodes() {
        let message = b"private relay";
        let mut chain = new_relay_chain();
        let mut prev_hash = [0u8; 32];
        let mut node_pubkeys: Vec<String> = vec![];

        for hop in 0..2u8 {
            let secret = make_secret(hop + 20);
            let attest = create_attestation(&secret, message, &prev_hash, hop, hop as i64)
                .expect("creation should succeed");

            // Collect the hex representation of each node_pubkey
            let pk_hex: String = attest
                .node_pubkey
                .iter()
                .map(|b| format!("{:02x}", b))
                .collect();
            node_pubkeys.push(pk_hex);

            prev_hash = attest.attestation;
            add_attestation(&mut chain, &attest).expect("add should succeed");
        }

        let record = chain_public_record(&chain);

        for pk_hex in &node_pubkeys {
            assert!(
                !record.contains(pk_hex.as_str()),
                "public record must not contain node_pubkey {}",
                pk_hex
            );
        }

        // Confirm the record contains the expected public fields
        assert!(record.contains("chain_proof"));
        assert!(record.contains("hop_count"));
        assert!(record.contains("mainnet_ready"));
    }
}
