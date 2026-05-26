// NOT_PRODUCTION — devnet design only
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

fn hex_encode(b: &[u8]) -> String {
    b.iter().map(|x| format!("{:02x}", x)).collect()
}
fn sha256_chain(prefix: &str, inputs: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(prefix.as_bytes());
    for i in inputs {
        h.update(i);
    }
    h.finalize().into()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SourceChain {
    Solana = 1,
    EthereumL2 = 2,
    Arbitrum = 3,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DestChain {
    Ethereum = 1,
    Arbitrum = 2,
    Optimism = 3,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SolanaProofSummary {
    pub program_id_hash: [u8; 32],
    pub instruction_hash: [u8; 32],
    pub slot: u64,
    pub nullifier: [u8; 32],
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CrossChainReceipt {
    pub source_chain: SourceChain,
    pub dest_chain: DestChain,
    pub bridge_hash: [u8; 32],
    pub solana_proof: SolanaProofSummary,
    pub evm_calldata_hash: [u8; 32],
    pub mainnet_ready: bool,
}

#[derive(Debug, PartialEq)]
pub enum CrossChainError {
    SameSourceAndDest,
    InvalidNullifier,
}

pub fn create_cross_chain_receipt(
    source_chain: SourceChain,
    dest_chain: DestChain,
    program_id_bytes: &[u8],
    instruction_data: &[u8],
    slot: u64,
    nullifier: &[u8; 32],
    evm_target_hash: &[u8; 32],
) -> Result<CrossChainReceipt, CrossChainError> {
    // Block same-network routing. SourceChain and DestChain share discriminant values
    // for same-network variants: EthereumL2(2)==Arbitrum(2), Arbitrum(3)==Optimism(3).
    // Only the EthereumL2→Arbitrum pair represents the same logical L2 network.
    // Solana(1)→Ethereum(1) is a valid cross-chain route despite sharing discriminant 1.
    let same = matches!(
        (source_chain, dest_chain),
        (SourceChain::EthereumL2, DestChain::Arbitrum)
            | (SourceChain::Arbitrum, DestChain::Arbitrum)
    );
    if same {
        return Err(CrossChainError::SameSourceAndDest);
    }
    if nullifier == &[0u8; 32] {
        return Err(CrossChainError::InvalidNullifier);
    }
    let program_id_hash = sha256_chain("sol-program-v1", &[program_id_bytes]);
    let instruction_hash = sha256_chain("sol-ix-v1", &[instruction_data]);
    let slot_le = slot.to_le_bytes();
    let bridge_hash = sha256_chain(
        "xchain-bridge-v1",
        &[
            &[source_chain as u8],
            &[dest_chain as u8],
            nullifier,
            &slot_le,
        ],
    );
    let evm_calldata_hash = sha256_chain("evm-calldata-v1", &[&bridge_hash, evm_target_hash]);
    Ok(CrossChainReceipt {
        source_chain,
        dest_chain,
        bridge_hash,
        solana_proof: SolanaProofSummary {
            program_id_hash,
            instruction_hash,
            slot,
            nullifier: *nullifier,
        },
        evm_calldata_hash,
        mainnet_ready: false,
    })
}

pub fn verify_cross_chain_receipt(receipt: &CrossChainReceipt) -> bool {
    receipt.bridge_hash != [0u8; 32]
        && receipt.evm_calldata_hash != [0u8; 32]
        && receipt.solana_proof.nullifier != [0u8; 32]
}

pub fn receipt_public_record(receipt: &CrossChainReceipt) -> String {
    let source = format!("{:?}", receipt.source_chain).to_lowercase();
    let dest = format!("{:?}", receipt.dest_chain).to_lowercase();
    serde_json::json!({
        "bridge_hash": hex_encode(&receipt.bridge_hash),
        "source_chain": source,
        "dest_chain": dest,
        "slot": receipt.solana_proof.slot,
        "evm_calldata_hash": hex_encode(&receipt.evm_calldata_hash),
        "mainnet_ready": receipt.mainnet_ready
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn nullifier(b: u8) -> [u8; 32] {
        let mut n = [b; 32];
        n[0] = 1;
        n
    }
    fn target() -> [u8; 32] {
        [0xAB; 32]
    }

    #[test]
    fn test_create_cross_chain_receipt_happy_path() {
        let r = create_cross_chain_receipt(
            SourceChain::Solana,
            DestChain::Ethereum,
            b"prog",
            b"ix",
            100_000,
            &nullifier(5),
            &target(),
        )
        .unwrap();
        assert_ne!(r.bridge_hash, [0u8; 32]);
        assert!(!r.mainnet_ready);
    }

    #[test]
    fn test_same_source_dest_rejected() {
        // SourceChain::EthereumL2 = 2, DestChain::Arbitrum = 2 (same discriminant)
        let err = create_cross_chain_receipt(
            SourceChain::EthereumL2,
            DestChain::Arbitrum,
            b"p",
            b"i",
            1,
            &nullifier(1),
            &target(),
        )
        .unwrap_err();
        assert_eq!(err, CrossChainError::SameSourceAndDest);
    }

    #[test]
    fn test_zero_nullifier_rejected() {
        let err = create_cross_chain_receipt(
            SourceChain::Solana,
            DestChain::Ethereum,
            b"p",
            b"i",
            1,
            &[0u8; 32],
            &target(),
        )
        .unwrap_err();
        assert_eq!(err, CrossChainError::InvalidNullifier);
    }

    #[test]
    fn test_bridge_hash_deterministic() {
        let a = create_cross_chain_receipt(
            SourceChain::Solana,
            DestChain::Ethereum,
            b"p",
            b"i",
            999,
            &nullifier(7),
            &target(),
        )
        .unwrap();
        let b = create_cross_chain_receipt(
            SourceChain::Solana,
            DestChain::Ethereum,
            b"p",
            b"i",
            999,
            &nullifier(7),
            &target(),
        )
        .unwrap();
        assert_eq!(a.bridge_hash, b.bridge_hash);
    }

    #[test]
    fn test_public_record_hides_instruction() {
        let r = create_cross_chain_receipt(
            SourceChain::Solana,
            DestChain::Optimism,
            b"prog_id_bytes",
            b"secret_instruction_data",
            42,
            &nullifier(3),
            &target(),
        )
        .unwrap();
        let json = receipt_public_record(&r);
        let ix_hex = "secret_instruction_data"
            .as_bytes()
            .iter()
            .map(|x| format!("{:02x}", x))
            .collect::<String>();
        assert!(!json.contains("secret_instruction_data"));
        assert!(!json.contains(&ix_hex));
    }
}
