// dark-commitment-chain — hash-linked commitment chain for private balance proofs
// Each node commits to (prev || delta || nonce) — audit chain without revealing amounts.
// NOT_PRODUCTION — devnet design only — no audit — mainnet_ready = false

use sha2::{Digest, Sha256};

// ---------------------------------------------------------------------------
// Domain separation constants
// ---------------------------------------------------------------------------

const DOMAIN_LINK: u8 = 0x01; // commitment link node
const DOMAIN_DELTA: u8 = 0x02; // delta commitment
const DOMAIN_BALANCE: u8 = 0x03; // balance proof commitment
const DOMAIN_GENESIS: u8 = 0x04; // chain genesis node

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

/// A single node in the hash-linked commitment chain.
#[derive(Debug, Clone, PartialEq)]
pub struct CommitmentNode {
    /// SHA256(DOMAIN_LINK || prev_hash || delta_commit || nonce)
    pub node_hash: [u8; 32],
    /// SHA256(DOMAIN_DELTA || delta_le_i64 || nonce) — hides actual delta
    pub delta_commit: [u8; 32],
    pub nonce: [u8; 32],
    /// Index in the chain (0 = genesis)
    pub index: u64,
    pub mainnet_ready: bool, // always false
}

/// An ordered, hash-linked list of commitment nodes.
#[derive(Debug, Clone)]
pub struct CommitmentChain {
    pub nodes: Vec<CommitmentNode>,
    pub genesis_hash: [u8; 32],
    pub mainnet_ready: bool, // always false
}

/// A zero-knowledge-style proof that a claimed balance is consistent with the
/// chain, without revealing the balance itself.
#[derive(Debug, Clone, PartialEq)]
pub struct BalanceProof {
    /// SHA256(DOMAIN_BALANCE || balance_le_u64 || chain_root || witness_nonce)
    pub balance_commit: [u8; 32],
    /// Hash of the last chain node — anchors the proof to the chain
    pub chain_tip: [u8; 32],
    /// Number of nodes traversed to build this proof
    pub depth: u64,
    pub mainnet_ready: bool, // always false
}

/// Errors that can occur when operating on a commitment chain.
#[derive(Debug, PartialEq)]
pub enum ChainError {
    EmptyChain,
    BrokenLink { at_index: u64 },
    InvalidDelta { at_index: u64 },
    BalanceUnderflow,
    NonceMissing,
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/// Compute SHA256(DOMAIN_GENESIS || initial_balance_commit || seed).
/// `initial_balance_commit` is itself SHA256(DOMAIN_BALANCE || balance_le_u64 || seed).
fn compute_genesis_hash(initial_balance: u64, seed: &[u8; 32]) -> [u8; 32] {
    // First build the initial balance commitment.
    let bal_commit = compute_balance_commit(initial_balance, &[0u8; 32], seed);

    let mut h = Sha256::new();
    h.update([DOMAIN_GENESIS]);
    h.update(bal_commit);
    h.update(seed);
    h.finalize().into()
}

/// SHA256(DOMAIN_DELTA || delta_le_i64 || nonce)
fn compute_delta_commit(delta: i64, nonce: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update([DOMAIN_DELTA]);
    h.update(delta.to_le_bytes());
    h.update(nonce);
    h.finalize().into()
}

/// SHA256(DOMAIN_LINK || prev_hash || delta_commit || nonce)
fn compute_node_hash(prev_hash: &[u8; 32], delta_commit: &[u8; 32], nonce: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update([DOMAIN_LINK]);
    h.update(prev_hash);
    h.update(delta_commit);
    h.update(nonce);
    h.finalize().into()
}

/// SHA256(DOMAIN_BALANCE || balance_le_u64 || chain_root || witness_nonce)
fn compute_balance_commit(
    balance: u64,
    chain_root: &[u8; 32],
    witness_nonce: &[u8; 32],
) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update([DOMAIN_BALANCE]);
    h.update(balance.to_le_bytes());
    h.update(chain_root);
    h.update(witness_nonce);
    h.finalize().into()
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Create a new genesis node (no prev, balance commitment only).
///
/// `genesis_hash = SHA256(DOMAIN_GENESIS || initial_balance_commit || seed)`
pub fn genesis(initial_balance: u64, seed: &[u8; 32]) -> CommitmentChain {
    let genesis_hash = compute_genesis_hash(initial_balance, seed);

    // The genesis node itself uses the genesis_hash as its node_hash and a
    // zeroed delta (no movement yet) committed with the seed as nonce.
    let delta_commit = compute_delta_commit(0i64, seed);
    let node_hash = genesis_hash; // genesis node hash IS the genesis hash

    let node = CommitmentNode {
        node_hash,
        delta_commit,
        nonce: *seed,
        index: 0,
        mainnet_ready: false,
    };

    CommitmentChain {
        nodes: vec![node],
        genesis_hash,
        mainnet_ready: false,
    }
}

/// Append a signed delta to the chain.
///
/// - `delta_commit = SHA256(DOMAIN_DELTA || delta_le_i64 || nonce)`
/// - `node_hash    = SHA256(DOMAIN_LINK || prev_node_hash || delta_commit || nonce)`
pub fn append<'a>(
    chain: &'a mut CommitmentChain,
    delta: i64,
    nonce: &[u8; 32],
) -> Result<&'a CommitmentNode, ChainError> {
    let prev_hash = match chain.nodes.last() {
        Some(n) => n.node_hash,
        None => return Err(ChainError::EmptyChain),
    };

    let index = chain.nodes.len() as u64;
    let delta_commit = compute_delta_commit(delta, nonce);
    let node_hash = compute_node_hash(&prev_hash, &delta_commit, nonce);

    chain.nodes.push(CommitmentNode {
        node_hash,
        delta_commit,
        nonce: *nonce,
        index,
        mainnet_ready: false,
    });

    Ok(chain.nodes.last().unwrap())
}

/// Verify the chain is unbroken: each node_hash correctly chains from the
/// previous one.  Returns `Ok(node_count)` if valid.
pub fn verify_chain(chain: &CommitmentChain) -> Result<u64, ChainError> {
    if chain.nodes.is_empty() {
        return Err(ChainError::EmptyChain);
    }

    // Genesis node: node_hash must equal genesis_hash.
    if chain.nodes[0].node_hash != chain.genesis_hash {
        return Err(ChainError::BrokenLink { at_index: 0 });
    }

    // Every subsequent node must chain correctly.
    for i in 1..chain.nodes.len() {
        let prev = &chain.nodes[i - 1];
        let cur = &chain.nodes[i];

        let expected = compute_node_hash(&prev.node_hash, &cur.delta_commit, &cur.nonce);
        if expected != cur.node_hash {
            return Err(ChainError::BrokenLink {
                at_index: cur.index,
            });
        }
    }

    Ok(chain.nodes.len() as u64)
}

/// Build a balance proof anchored to the chain's current tip.
///
/// Does NOT embed the raw balance — only the commitment.
/// Returns `Err(BrokenLink)` if the chain has been tampered with.
pub fn prove_balance(
    chain: &CommitmentChain,
    claimed_balance: u64,
    witness_nonce: &[u8; 32],
) -> Result<BalanceProof, ChainError> {
    // Must be a valid chain.
    let depth = verify_chain(chain)?;

    let chain_tip = chain.nodes.last().unwrap().node_hash;
    let balance_commit = compute_balance_commit(claimed_balance, &chain_tip, witness_nonce);

    Ok(BalanceProof {
        balance_commit,
        chain_tip,
        depth,
        mainnet_ready: false,
    })
}

/// Verify a balance proof against a known chain tip.
///
/// Returns `true` only if `proof.chain_tip == chain_tip`.
/// Note: this verifies chain-tip binding, not the balance value itself
/// (the balance is hidden inside the commitment).
pub fn verify_balance_proof(proof: &BalanceProof, chain_tip: &[u8; 32]) -> bool {
    proof.chain_tip == *chain_tip
}

/// Redact a chain for public viewing: return only the ordered node hashes.
/// No deltas, no nonces are included.
pub fn public_chain_digest(chain: &CommitmentChain) -> Vec<[u8; 32]> {
    chain.nodes.iter().map(|n| n.node_hash).collect()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn seed(b: u8) -> [u8; 32] {
        [b; 32]
    }

    fn nonce(b: u8) -> [u8; 32] {
        [b; 32]
    }

    // 1. Genesis always has mainnet_ready = false
    #[test]
    fn test_genesis_mainnet_ready_false() {
        let chain = genesis(1_000, &seed(0xAA));
        assert!(!chain.mainnet_ready);
        assert!(!chain.nodes[0].mainnet_ready);
    }

    // 2. Genesis hash is deterministic for same inputs
    #[test]
    fn test_genesis_node_hash_deterministic() {
        let c1 = genesis(500, &seed(0x01));
        let c2 = genesis(500, &seed(0x01));
        assert_eq!(c1.genesis_hash, c2.genesis_hash);
        assert_eq!(c1.nodes[0].node_hash, c2.nodes[0].node_hash);
    }

    // 3. Mutate a mid-chain node; verify_chain must report BrokenLink
    #[test]
    fn test_append_chain_link_breaks_on_tamper() {
        let mut chain = genesis(100, &seed(0x10));
        append(&mut chain, 50, &nonce(0x11)).unwrap();
        append(&mut chain, -20, &nonce(0x12)).unwrap();

        // Tamper: flip a byte in node 1's hash
        chain.nodes[1].node_hash[0] ^= 0xFF;

        let result = verify_chain(&chain);
        assert!(result.is_err());
        match result.unwrap_err() {
            // node 1's hash was mutated directly — verify_chain detects the
            // mismatch when it re-derives node 1's expected hash and finds it
            // doesn't match the stored (tampered) value.
            ChainError::BrokenLink { at_index } => assert_eq!(at_index, 1),
            e => panic!("Expected BrokenLink, got {:?}", e),
        }
    }

    // 4. verify_chain on empty chain returns EmptyChain
    #[test]
    fn test_verify_chain_empty_returns_err() {
        let empty = CommitmentChain {
            nodes: vec![],
            genesis_hash: [0u8; 32],
            mainnet_ready: false,
        };
        assert_eq!(verify_chain(&empty), Err(ChainError::EmptyChain));
    }

    // 5. Append a single positive delta; chain is valid and length is 2
    #[test]
    fn test_append_single_delta_positive() {
        let mut chain = genesis(0, &seed(0x20));
        append(&mut chain, 100, &nonce(0x21)).unwrap();
        assert_eq!(chain.nodes.len(), 2);
        assert_eq!(verify_chain(&chain), Ok(2));
    }

    // 6. Append a negative delta; chain is still valid
    #[test]
    fn test_append_negative_delta_chains_correctly() {
        let mut chain = genesis(1_000, &seed(0x30));
        append(&mut chain, -250, &nonce(0x31)).unwrap();
        assert_eq!(verify_chain(&chain), Ok(2));
        assert_eq!(chain.nodes[1].index, 1);
    }

    // 7. Multiple sequential appends; all indices and chain integrity correct
    #[test]
    fn test_multi_append_sequential() {
        let mut chain = genesis(0, &seed(0x40));
        for i in 1u8..=5 {
            append(&mut chain, i as i64 * 10, &nonce(i)).unwrap();
        }
        assert_eq!(chain.nodes.len(), 6);
        for (i, node) in chain.nodes.iter().enumerate() {
            assert_eq!(node.index, i as u64);
        }
        assert_eq!(verify_chain(&chain), Ok(6));
    }

    // 8. prove_balance chain_tip matches the last node hash
    #[test]
    fn test_prove_balance_tip_matches() {
        let mut chain = genesis(500, &seed(0x50));
        append(&mut chain, 100, &nonce(0x51)).unwrap();
        let proof = prove_balance(&chain, 600, &nonce(0x52)).unwrap();
        assert_eq!(proof.chain_tip, chain.nodes.last().unwrap().node_hash);
        assert!(!proof.mainnet_ready);
    }

    // 9. verify_balance_proof passes when tip matches
    #[test]
    fn test_verify_balance_proof_passes() {
        let mut chain = genesis(1_000, &seed(0x60));
        append(&mut chain, -100, &nonce(0x61)).unwrap();
        let proof = prove_balance(&chain, 900, &nonce(0x62)).unwrap();
        let tip = chain.nodes.last().unwrap().node_hash;
        assert!(verify_balance_proof(&proof, &tip));
    }

    // 10. verify_balance_proof fails when wrong tip is supplied
    #[test]
    fn test_verify_balance_proof_fails_wrong_tip() {
        let mut chain = genesis(1_000, &seed(0x70));
        append(&mut chain, 50, &nonce(0x71)).unwrap();
        let proof = prove_balance(&chain, 1_050, &nonce(0x72)).unwrap();
        let wrong_tip = [0xDE_u8; 32];
        assert!(!verify_balance_proof(&proof, &wrong_tip));
    }

    // 11. public_chain_digest length equals node count
    #[test]
    fn test_public_digest_length_matches_node_count() {
        let mut chain = genesis(0, &seed(0x80));
        append(&mut chain, 10, &nonce(0x81)).unwrap();
        append(&mut chain, 20, &nonce(0x82)).unwrap();
        let digest = public_chain_digest(&chain);
        assert_eq!(digest.len(), chain.nodes.len());
        for (d, n) in digest.iter().zip(chain.nodes.iter()) {
            assert_eq!(d, &n.node_hash);
        }
    }

    // 12. Different nonces produce different delta_commit values for same delta
    #[test]
    fn test_different_nonces_produce_different_deltas() {
        let dc1 = compute_delta_commit(42, &nonce(0xAA));
        let dc2 = compute_delta_commit(42, &nonce(0xBB));
        assert_ne!(dc1, dc2);
    }

    // 13. Two chains with same deltas but different nonces produce different node hashes
    #[test]
    fn test_two_chains_same_deltas_different_nonces_produce_different_nodes() {
        let mut c1 = genesis(0, &seed(0x01));
        let mut c2 = genesis(0, &seed(0x02));
        append(&mut c1, 100, &nonce(0x10)).unwrap();
        append(&mut c2, 100, &nonce(0x20)).unwrap();
        assert_ne!(
            c1.nodes[1].node_hash, c2.nodes[1].node_hash,
            "Different nonces must produce different node hashes"
        );
    }

    // 14. BalanceProof struct does not embed the raw u64 balance
    //     We verify this by checking the balance_commit is NOT simply the
    //     little-endian encoding of the claimed balance anywhere in the struct.
    #[test]
    fn test_balance_proof_does_not_embed_raw_balance() {
        let mut chain = genesis(999_999, &seed(0xCC));
        append(&mut chain, 1, &nonce(0xDD)).unwrap();
        let claimed: u64 = 999_999;
        let proof = prove_balance(&chain, claimed, &nonce(0xEE)).unwrap();

        let raw_bytes = claimed.to_le_bytes();

        // balance_commit must NOT equal the raw bytes padded to 32
        let mut padded = [0u8; 32];
        padded[..8].copy_from_slice(&raw_bytes);
        assert_ne!(
            proof.balance_commit, padded,
            "balance_commit must not be a trivial encoding of the raw balance"
        );

        // balance_commit must NOT equal the raw bytes repeated
        let repeated: Vec<u8> = raw_bytes.iter().cycle().take(32).cloned().collect();
        let mut rep32 = [0u8; 32];
        rep32.copy_from_slice(&repeated);
        assert_ne!(proof.balance_commit, rep32);

        // The raw u64 bytes must not appear verbatim in chain_tip either
        assert!(
            !proof.chain_tip.windows(8).any(|w| w == raw_bytes),
            "chain_tip must not contain raw balance bytes"
        );
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_genesis_node_index_is_zero() {
        let chain = genesis(0, &seed(0xAA));
        assert_eq!(chain.nodes[0].index, 0);
    }

    #[test]
    fn test_genesis_creates_exactly_one_node() {
        let chain = genesis(500, &seed(0x01));
        assert_eq!(chain.nodes.len(), 1);
    }
}
