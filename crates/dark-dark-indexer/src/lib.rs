use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

// ── Types ──────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexEntry {
    pub entry_hash: [u8; 32],
    pub category_hash: [u8; 32],
    pub slot: u64,
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DarkIndex {
    pub index_id: [u8; 32],
    pub entries: Vec<IndexEntry>,
    pub root: [u8; 32],
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexQuery {
    pub query_hash: [u8; 32],
    pub category_hash: [u8; 32],
    pub found: bool,
    pub match_count: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub enum IndexError {
    EmptyData,
    ZeroIndexSecret,
    EmptyCategory,
}

// ── Internal hash helpers ──────────────────────────────────────────────────────

fn sha256_bytes(data: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(data);
    h.finalize().into()
}

fn compute_index_id(index_secret: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"idx-id-v1");
    h.update(index_secret);
    h.finalize().into()
}

fn compute_category_hash(category_bytes: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"idx-category-v1");
    h.update(category_bytes);
    h.finalize().into()
}

fn compute_entry_hash(category_hash: &[u8; 32], data_bytes: &[u8], slot: u64) -> [u8; 32] {
    let data_hash = sha256_bytes(data_bytes);
    let slot_le = slot.to_le_bytes();
    let mut h = Sha256::new();
    h.update(b"idx-entry-v1");
    h.update(category_hash);
    h.update(&data_hash);
    h.update(&slot_le);
    h.finalize().into()
}

fn compute_root(entries: &[IndexEntry]) -> [u8; 32] {
    if entries.is_empty() {
        return [0u8; 32];
    }
    // XOR-fold all entry_hashes
    let mut acc = [0u8; 32];
    for entry in entries {
        for (a, b) in acc.iter_mut().zip(entry.entry_hash.iter()) {
            *a ^= b;
        }
    }
    let mut h = Sha256::new();
    h.update(b"idx-root-v1");
    h.update(&acc);
    h.finalize().into()
}

fn compute_query_hash(category_hash: &[u8; 32], querier_nonce: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"idx-query-v1");
    h.update(category_hash);
    h.update(querier_nonce);
    h.finalize().into()
}

// ── Public API ─────────────────────────────────────────────────────────────────

/// Create a new empty DarkIndex.
/// Returns ZeroIndexSecret if `index_secret` is all zeros.
/// `mainnet_ready` is always false.
pub fn new_index(index_secret: &[u8; 32]) -> Result<DarkIndex, IndexError> {
    if index_secret == &[0u8; 32] {
        return Err(IndexError::ZeroIndexSecret);
    }
    let index_id = compute_index_id(index_secret);
    Ok(DarkIndex {
        index_id,
        entries: Vec::new(),
        root: [0u8; 32],
        mainnet_ready: false,
    })
}

/// Add an entry to the index.
/// Returns EmptyData if `data_bytes` is empty.
/// Returns EmptyCategory if `category_bytes` is empty.
/// Updates the root after insertion.
/// `mainnet_ready` on returned entry is always false.
pub fn add_entry(
    index: &mut DarkIndex,
    data_bytes: &[u8],
    category_bytes: &[u8],
    slot: u64,
) -> Result<IndexEntry, IndexError> {
    if data_bytes.is_empty() {
        return Err(IndexError::EmptyData);
    }
    if category_bytes.is_empty() {
        return Err(IndexError::EmptyCategory);
    }
    let category_hash = compute_category_hash(category_bytes);
    let entry_hash = compute_entry_hash(&category_hash, data_bytes, slot);
    let entry = IndexEntry {
        entry_hash,
        category_hash,
        slot,
        mainnet_ready: false,
    };
    index.entries.push(entry.clone());
    index.root = compute_root(&index.entries);
    Ok(entry)
}

/// Query the index for entries matching the given category.
/// Returns an IndexQuery with found=true and match_count>0 if any entry matches.
pub fn query_category(
    index: &DarkIndex,
    category_bytes: &[u8],
    querier_nonce: &[u8; 32],
) -> IndexQuery {
    let category_hash = compute_category_hash(category_bytes);
    let query_hash = compute_query_hash(&category_hash, querier_nonce);
    let match_count = index
        .entries
        .iter()
        .filter(|e| e.category_hash == category_hash)
        .count() as u32;
    IndexQuery {
        query_hash,
        category_hash,
        found: match_count > 0,
        match_count,
    }
}

/// Return a JSON public record of the index.
/// Includes: index_id (hex), entry_count, root (hex), mainnet_ready.
/// Does NOT include any individual entry_hashes.
pub fn index_public_record(index: &DarkIndex) -> String {
    let obj = serde_json::json!({
        "index_id": hex_encode(&index.index_id),
        "entry_count": index.entries.len(),
        "root": hex_encode(&index.root),
        "mainnet_ready": index.mainnet_ready,
    });
    serde_json::to_string(&obj).expect("serialization cannot fail")
}

fn hex_encode(bytes: &[u8; 32]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

// ── Tests ──────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn nonzero_secret() -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = 0xAB;
        s
    }

    fn nonce() -> [u8; 32] {
        let mut n = [0u8; 32];
        n[31] = 0x01;
        n
    }

    // Test 1: add 2 entries same category, query finds both (match_count=2)
    #[test]
    fn test_add_query_happy_path() {
        let mut idx = new_index(&nonzero_secret()).unwrap();
        add_entry(&mut idx, b"data-alpha", b"my-category", 1).unwrap();
        add_entry(&mut idx, b"data-beta", b"my-category", 2).unwrap();

        let q = query_category(&idx, b"my-category", &nonce());
        assert!(q.found);
        assert_eq!(q.match_count, 2);
    }

    // Test 2: query for category not inserted → found=false, match_count=0
    #[test]
    fn test_query_different_category_not_found() {
        let mut idx = new_index(&nonzero_secret()).unwrap();
        add_entry(&mut idx, b"some-data", b"cat-A", 10).unwrap();

        let q = query_category(&idx, b"cat-B", &nonce());
        assert!(!q.found);
        assert_eq!(q.match_count, 0);
    }

    // Test 3: root before first insert differs from root after
    #[test]
    fn test_root_changes_on_insert() {
        let mut idx = new_index(&nonzero_secret()).unwrap();
        let root_before = idx.root;
        add_entry(&mut idx, b"payload", b"cat-X", 5).unwrap();
        let root_after = idx.root;
        assert_ne!(root_before, root_after);
    }

    // Test 4: zero secret → ZeroIndexSecret
    #[test]
    fn test_zero_secret_rejected() {
        let result = new_index(&[0u8; 32]);
        assert_eq!(result.unwrap_err(), IndexError::ZeroIndexSecret);
    }

    // Test 5: empty data → EmptyData
    #[test]
    fn test_empty_data_rejected() {
        let mut idx = new_index(&nonzero_secret()).unwrap();
        let result = add_entry(&mut idx, b"", b"cat-Y", 0);
        assert_eq!(result.unwrap_err(), IndexError::EmptyData);
    }

    // Test 6: public record does not expose individual entry_hashes
    #[test]
    fn test_public_record_hides_entry_hashes() {
        let mut idx = new_index(&nonzero_secret()).unwrap();
        let entry = add_entry(&mut idx, b"secret-payload", b"cat-Z", 99).unwrap();

        let record = index_public_record(&idx);

        // The individual entry_hash must not appear anywhere in the JSON output
        let entry_hash_hex: String = entry
            .entry_hash
            .iter()
            .map(|b| format!("{:02x}", b))
            .collect();
        assert!(
            !record.contains(&entry_hash_hex),
            "public record must not contain individual entry_hash: {}",
            entry_hash_hex
        );

        // Sanity: the record should contain expected keys
        assert!(record.contains("index_id"));
        assert!(record.contains("entry_count"));
        assert!(record.contains("root"));
        assert!(record.contains("mainnet_ready"));
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_index_id_nonzero() {
        let idx = new_index(&nonzero_secret()).unwrap();
        assert_ne!(idx.index_id, [0u8; 32]);
    }

    #[test]
    fn test_index_id_deterministic() {
        let i1 = new_index(&nonzero_secret()).unwrap();
        let i2 = new_index(&nonzero_secret()).unwrap();
        assert_eq!(i1.index_id, i2.index_id);
    }

    #[test]
    fn test_index_id_secret_sensitive() {
        let mut secret2 = nonzero_secret();
        secret2[1] = 0xCC;
        let i1 = new_index(&nonzero_secret()).unwrap();
        let i2 = new_index(&secret2).unwrap();
        assert_ne!(i1.index_id, i2.index_id);
    }

    #[test]
    fn test_mainnet_ready_always_false() {
        let idx = new_index(&nonzero_secret()).unwrap();
        assert!(!idx.mainnet_ready);
    }

    #[test]
    fn test_entry_mainnet_ready_false() {
        let mut idx = new_index(&nonzero_secret()).unwrap();
        let entry = add_entry(&mut idx, b"data", b"cat", 1).unwrap();
        assert!(!entry.mainnet_ready);
    }

    #[test]
    fn test_entry_hash_nonzero() {
        let mut idx = new_index(&nonzero_secret()).unwrap();
        let entry = add_entry(&mut idx, b"payload", b"category", 10).unwrap();
        assert_ne!(entry.entry_hash, [0u8; 32]);
    }

    #[test]
    fn test_entry_hash_deterministic() {
        let mut idx = new_index(&nonzero_secret()).unwrap();
        let e1 = add_entry(&mut idx, b"same-data", b"cat", 5).unwrap();
        let mut idx2 = new_index(&nonzero_secret()).unwrap();
        let e2 = add_entry(&mut idx2, b"same-data", b"cat", 5).unwrap();
        assert_eq!(e1.entry_hash, e2.entry_hash);
    }

    #[test]
    fn test_entry_hash_slot_sensitive() {
        let mut idx = new_index(&nonzero_secret()).unwrap();
        let e1 = add_entry(&mut idx, b"data", b"cat", 100).unwrap();
        let mut idx2 = new_index(&nonzero_secret()).unwrap();
        let e2 = add_entry(&mut idx2, b"data", b"cat", 200).unwrap();
        assert_ne!(e1.entry_hash, e2.entry_hash);
    }

    #[test]
    fn test_empty_category_rejected() {
        let mut idx = new_index(&nonzero_secret()).unwrap();
        let result = add_entry(&mut idx, b"data", b"", 0);
        assert_eq!(result.unwrap_err(), IndexError::EmptyCategory);
    }

    #[test]
    fn test_root_is_zero_for_empty_index() {
        let idx = new_index(&nonzero_secret()).unwrap();
        assert_eq!(idx.root, [0u8; 32]);
    }
}
