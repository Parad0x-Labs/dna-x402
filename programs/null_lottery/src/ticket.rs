//! Ticket commitments and the tickets Merkle tree that ClaimJackpot verifies.
//!
//! AnchorTickets stores `tickets_root`, the root of a binary SHA-256 Merkle tree
//! over the round's tickets, and `ticket_count`. Leaf `i` is the ticket at
//! position `i`:
//!
//! ```text
//! leaf = SHA-256("dark-null-lottery:ticket:v1" || round_id_le[8] || owner[32]
//!                || numbers[5] || nullifier[32])
//! node = SHA-256(0x01 || left[32] || right[32])
//! ```
//!
//! `numbers` are the ticket's 5 numbers in ascending order and `owner` is the
//! Solana key allowed to claim the ticket. The tree has depth
//! `ceil(log2(ticket_count))`; a level with an odd number of nodes is padded by
//! repeating its last node. A proof is the list of sibling hashes from the leaf
//! up; bit `k` of the leaf index says whether the node at level `k` is a right
//! child.
//!
//! ClaimJackpot on a Drawn round rebuilds the leaf from the claimant's key, the
//! claimed numbers and nullifier, and requires (a) the numbers to equal the drawn
//! numbers and (b) the leaf to be at `leaf_index < ticket_count` under
//! `tickets_root`.

use solana_program::hash::hashv;

/// Domain separation tag of a ticket leaf.
pub const TICKET_LEAF_TAG: &[u8] = b"dark-null-lottery:ticket:v1";
/// Prefix of an inner node (a leaf preimage starts with the tag above).
pub const NODE_PREFIX: &[u8] = &[0x01];
/// Upper bound on the proof length accepted by ClaimJackpot.
pub const MAX_PROOF_DEPTH: usize = 32;

/// Leaf commitment of one ticket.
pub fn ticket_leaf(round_id: u64, owner: &[u8; 32], numbers: &[u8; 5], nullifier: &[u8; 32]) -> [u8; 32] {
    hashv(&[TICKET_LEAF_TAG, &round_id.to_le_bytes(), owner, numbers, nullifier]).to_bytes()
}

/// Inner node of the tickets tree.
pub fn node(left: &[u8; 32], right: &[u8; 32]) -> [u8; 32] {
    hashv(&[NODE_PREFIX, left, right]).to_bytes()
}

/// Tree depth for `count` leaves: ceil(log2(count)), 0 for count <= 1.
pub fn tree_depth(count: u64) -> usize {
    if count <= 1 {
        0
    } else {
        (64 - (count - 1).leading_zeros()) as usize
    }
}

/// Root reached from `leaf` at position `index` with sibling path `proof`.
pub fn root_from_proof(leaf: [u8; 32], index: u64, proof: &[[u8; 32]]) -> [u8; 32] {
    let mut acc = leaf;
    for (level, sibling) in proof.iter().enumerate() {
        acc = if (index >> level) & 1 == 1 { node(sibling, &acc) } else { node(&acc, sibling) };
    }
    acc
}

/// The 5 drawn numbers in ascending order (the form a ticket commits to).
pub fn sorted_numbers(numbers: &[u8; 5]) -> [u8; 5] {
    let mut n = *numbers;
    for i in 1..n.len() {
        let mut j = i;
        while j > 0 && n[j - 1] > n[j] {
            n.swap(j - 1, j);
            j -= 1;
        }
    }
    n
}

/// Off-chain helper: root of the tickets tree over `leaves` (in ticket order).
pub fn tickets_root(leaves: &[[u8; 32]]) -> [u8; 32] {
    if leaves.is_empty() {
        return [0u8; 32];
    }
    let mut level: Vec<[u8; 32]> = leaves.to_vec();
    while level.len() > 1 {
        level = next_level(&level);
    }
    level[0]
}

/// Off-chain helper: sibling path for leaf `index`.
pub fn tickets_proof(leaves: &[[u8; 32]], index: usize) -> Vec<[u8; 32]> {
    let mut proof = Vec::new();
    let mut level: Vec<[u8; 32]> = leaves.to_vec();
    let mut i = index;
    while level.len() > 1 {
        let sib = i ^ 1;
        proof.push(*level.get(sib).unwrap_or(&level[level.len() - 1]));
        level = next_level(&level);
        i >>= 1;
    }
    proof
}

fn next_level(level: &[[u8; 32]]) -> Vec<[u8; 32]> {
    level
        .chunks(2)
        .map(|c| node(&c[0], c.get(1).unwrap_or(&c[0])))
        .collect()
}
