use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

// ── Types ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OracleRequest {
    pub request_id: [u8; 32],
    pub requester_hash: [u8; 32],
    pub query_hash: [u8; 32],
    pub blinded_query: [u8; 32],
    pub reveal_nonce: [u8; 32],
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OracleResponse {
    pub request_id: [u8; 32],
    pub oracle_hash: [u8; 32],
    pub response_commitment: [u8; 32],
    pub answer_hash: [u8; 32],
    pub mainnet_ready: bool,
}

#[derive(Debug, PartialEq)]
pub enum OracleError {
    ZeroRequesterSecret,
    ZeroOracleSecret,
    EmptyQuery,
    EmptyAnswer,
    RequestMismatch,
}

// ── Helpers ────────────────────────────────────────────────────────────────

fn sha256_multi(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

fn hex32(b: &[u8; 32]) -> String {
    b.iter().map(|x| format!("{:02x}", x)).collect()
}

// ── API ────────────────────────────────────────────────────────────────────

pub fn submit_request(
    requester_secret: &[u8; 32],
    query_bytes: &[u8],
    reveal_nonce: &[u8; 32],
) -> Result<OracleRequest, OracleError> {
    if requester_secret == &[0u8; 32] {
        return Err(OracleError::ZeroRequesterSecret);
    }
    if query_bytes.is_empty() {
        return Err(OracleError::EmptyQuery);
    }
    let requester_hash = sha256_multi(&[b"oracle2-req-v1", requester_secret]);
    let query_hash = sha256_multi(&[b"oracle2-query-v1", query_bytes]);
    let blinded_query = sha256_multi(&[b"oracle2-blind-v1", &query_hash, reveal_nonce]);
    let request_id = sha256_multi(&[b"oracle2-reqid-v1", &requester_hash, &blinded_query]);
    Ok(OracleRequest {
        request_id,
        requester_hash,
        query_hash,
        blinded_query,
        reveal_nonce: *reveal_nonce,
        mainnet_ready: false,
    })
}

pub fn submit_response(
    oracle_secret: &[u8; 32],
    request: &OracleRequest,
    answer_bytes: &[u8],
) -> Result<OracleResponse, OracleError> {
    if oracle_secret == &[0u8; 32] {
        return Err(OracleError::ZeroOracleSecret);
    }
    if answer_bytes.is_empty() {
        return Err(OracleError::EmptyAnswer);
    }
    let oracle_hash = sha256_multi(&[b"oracle2-oracle-v1", oracle_secret]);
    let answer_hash = sha256_multi(&[b"oracle2-answer-v1", answer_bytes]);
    let response_commitment = sha256_multi(&[
        b"oracle2-resp-v1",
        &oracle_hash,
        &request.blinded_query,
        &answer_hash,
    ]);
    Ok(OracleResponse {
        request_id: request.request_id,
        oracle_hash,
        response_commitment,
        answer_hash,
        mainnet_ready: false,
    })
}

pub fn verify_response(request: &OracleRequest, response: &OracleResponse) -> bool {
    if response.request_id != request.request_id {
        return false;
    }
    let expected = sha256_multi(&[
        b"oracle2-resp-v1",
        &response.oracle_hash,
        &request.blinded_query,
        &response.answer_hash,
    ]);
    expected == response.response_commitment
}

pub fn request_public_record(req: &OracleRequest) -> String {
    serde_json::json!({
        "request_id": hex32(&req.request_id),
        "blinded_query": hex32(&req.blinded_query),
        "mainnet_ready": req.mainnet_ready,
    })
    .to_string()
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn secret(b: u8) -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = b;
        s
    }
    fn nonce(b: u8) -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = b;
        s
    }

    // Test 1: request + respond + verify
    #[test]
    fn test_request_respond_verify() {
        let req = submit_request(&secret(0x11), b"what-is-btc-price", &nonce(0xAA)).unwrap();
        assert!(!req.mainnet_ready);
        let resp = submit_response(&secret(0x22), &req, b"65000-usd").unwrap();
        assert!(!resp.mainnet_ready);
        assert!(verify_response(&req, &resp));
    }

    // Test 2: different queries → different blinded_queries
    #[test]
    fn test_different_queries_different_blinded() {
        let nonce = nonce(0xBB);
        let req1 = submit_request(&secret(0x33), b"query-alpha", &nonce).unwrap();
        let req2 = submit_request(&secret(0x33), b"query-beta", &nonce).unwrap();
        assert_ne!(req1.blinded_query, req2.blinded_query);
        assert_ne!(req1.query_hash, req2.query_hash);
    }

    // Test 3: different answers → different response_commitments
    #[test]
    fn test_different_answers_different_commitments() {
        let req = submit_request(&secret(0x44), b"the-question", &nonce(0xCC)).unwrap();
        let resp1 = submit_response(&secret(0x55), &req, b"answer-one").unwrap();
        let resp2 = submit_response(&secret(0x55), &req, b"answer-two").unwrap();
        assert_ne!(resp1.response_commitment, resp2.response_commitment);
        assert_ne!(resp1.answer_hash, resp2.answer_hash);
    }

    // Test 4: zero requester rejected
    #[test]
    fn test_zero_requester_rejected() {
        let zero = [0u8; 32];
        let err = submit_request(&zero, b"some-query", &nonce(0xDD)).unwrap_err();
        assert_eq!(err, OracleError::ZeroRequesterSecret);
    }

    // Test 5: empty query rejected
    #[test]
    fn test_empty_query_rejected() {
        let err = submit_request(&secret(0x66), b"", &nonce(0xEE)).unwrap_err();
        assert_eq!(err, OracleError::EmptyQuery);
    }

    // Test 6: public record hides requester
    #[test]
    fn test_public_record_hides_requester() {
        let requester_secret = secret(0x77);
        let req = submit_request(&requester_secret, b"private-query", &nonce(0xFF)).unwrap();
        let record = request_public_record(&req);
        let v: serde_json::Value = serde_json::from_str(&record).unwrap();
        assert!(v["request_id"].is_string());
        assert!(v["blinded_query"].is_string());
        assert_eq!(v["mainnet_ready"], false);
        // requester_hash and reveal_nonce must not appear
        let rh_hex = hex32(&req.requester_hash);
        assert!(!record.contains(&rh_hex));
        assert!(v.get("requester_hash").is_none());
        assert!(v.get("reveal_nonce").is_none());
    }
}
