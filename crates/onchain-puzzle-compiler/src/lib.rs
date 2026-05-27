use sha2::{Digest, Sha256};

// ---------------------------------------------------------------------------
// Private domain-separated hash helper
// ---------------------------------------------------------------------------

#[allow(dead_code)]
fn sha256_domain(domain: &[u8], inputs: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(domain);
    for input in inputs {
        h.update(input);
    }
    h.finalize().into()
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum PuzzleMethod {
    ShardAscii,
    AltOrderCipher,
    ReceiptRootAcrostic,
    ChaffConstellation,
    CouponNonceCipher,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PuzzleCompileInput {
    pub message: String,
    pub method: PuzzleMethod,
    pub target_network: String,
}

/// One letter's shard target in the ritual.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ShardTarget {
    pub letter: char,
    pub shard_byte: u8, // = letter as u8 for ShardAscii
    pub position: usize,
    /// Placeholder: brute-force nullifier must satisfy:
    ///   SHA256(nullifier || epoch_le64 || "dark_null_v1")[0] == shard_byte
    /// [0;32] means "not yet found"
    pub nullifier_placeholder: [u8; 32],
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PuzzleOutput {
    pub method: PuzzleMethod,
    pub message: String,
    pub shard_targets: Vec<ShardTarget>,
    pub decode_instructions: String,
    pub proof_markdown: String,
    pub puzzle_score: f32, // 0.0 to 1.0
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PuzzleError {
    EmptyMessage,
    NonAsciiMessage,
    UnsupportedMethod,
}

// ---------------------------------------------------------------------------
// Public functions
// ---------------------------------------------------------------------------

/// Compile a message into a puzzle plan.
///
/// For ShardAscii each letter's `shard_byte` is `letter as u8` (ASCII value).
/// Other methods use the same ASCII-based shard_byte but emit different
/// decode instructions.
pub fn compile_puzzle(input: &PuzzleCompileInput) -> Result<PuzzleOutput, PuzzleError> {
    if input.message.is_empty() {
        return Err(PuzzleError::EmptyMessage);
    }
    if !input.message.is_ascii() {
        return Err(PuzzleError::NonAsciiMessage);
    }

    // Build shard targets — method-independent for now; each letter uses its
    // raw ASCII value as the shard byte.
    let shard_targets: Vec<ShardTarget> = input
        .message
        .chars()
        .enumerate()
        .map(|(pos, letter)| ShardTarget {
            letter,
            shard_byte: letter as u8,
            position: pos,
            nullifier_placeholder: [0u8; 32],
        })
        .collect();

    // All chars are ASCII (checked above) → full score.
    let puzzle_score: f32 = 1.0;

    let decode_instructions = build_decode_instructions(&input.method);
    let proof_markdown = build_proof_markdown(&shard_targets);

    Ok(PuzzleOutput {
        method: input.method.clone(),
        message: input.message.clone(),
        shard_targets,
        decode_instructions,
        proof_markdown,
        puzzle_score,
    })
}

/// Verify that a given nullifier satisfies the ritual formula for a shard target.
///
/// Formula: SHA256(nullifier_bytes || epoch.to_le_bytes() || domain)[0] == expected_shard_byte
pub fn verify_nullifier_for_shard(
    nullifier_bytes: &[u8],
    expected_shard_byte: u8,
    epoch: u64,
    domain: &[u8],
) -> bool {
    let epoch_bytes = epoch.to_le_bytes();
    // NOTE: sha256_domain prepends domain then concatenates inputs.
    // The ritual formula is SHA256(nullifier || epoch_le64 || domain).
    // We implement that directly here to match the spec exactly (domain is a
    // *suffix* in the spec, not a prefix as sha256_domain would give us).
    let mut h = Sha256::new();
    h.update(nullifier_bytes);
    h.update(epoch_bytes);
    h.update(domain);
    let digest: [u8; 32] = h.finalize().into();
    digest[0] == expected_shard_byte
}

/// Parse a lowercase or uppercase hex string into bytes.
///
/// Returns `PuzzleError::NonAsciiMessage` (re-used as a parse error) if the
/// string has an odd length or contains non-hex characters.
pub fn hex_to_bytes(hex: &str) -> Result<Vec<u8>, PuzzleError> {
    if hex.len() % 2 != 0 {
        return Err(PuzzleError::NonAsciiMessage);
    }
    hex.as_bytes()
        .chunks(2)
        .map(|pair| {
            let hi = hex_nibble(pair[0]).ok_or(PuzzleError::NonAsciiMessage)?;
            let lo = hex_nibble(pair[1]).ok_or(PuzzleError::NonAsciiMessage)?;
            Ok((hi << 4) | lo)
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

fn hex_nibble(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

fn build_decode_instructions(method: &PuzzleMethod) -> String {
    let method_note = match method {
        PuzzleMethod::ShardAscii => {
            "ShardAscii: shard_byte for each letter equals its raw ASCII code point."
        }
        PuzzleMethod::AltOrderCipher => {
            "AltOrderCipher: letters are encoded at alternating index offsets before ASCII mapping."
        }
        PuzzleMethod::ReceiptRootAcrostic => {
            "ReceiptRootAcrostic: letters form the acrostic of receipt root commitments."
        }
        PuzzleMethod::ChaffConstellation => {
            "ChaffConstellation: letters are interleaved with dark chaff shards."
        }
        PuzzleMethod::CouponNonceCipher => {
            "CouponNonceCipher: nonce counters are mixed with coupon nullifiers per letter."
        }
    };

    format!(
        "DARKNULL Ritual Decode Instructions\n\
         =====================================\n\
         Domain: dark_null_v1\n\
         Method: {method_note}\n\n\
         For each ShardTarget, find a 32-byte nullifier such that:\n\
           SHA256(nullifier || epoch_le64 || \"dark_null_v1\")[0] == shard_byte\n\n\
         This is an offline brute-force search over the 256-bit nullifier space.\n\
         The nullifier_placeholder field ([0;32]) marks unsolved shards.\n\
         Solved nullifiers are submitted as on-chain ritual transactions.\n\
         Network: Solana. Epoch field is a u64 little-endian integer."
    )
}

fn build_proof_markdown(targets: &[ShardTarget]) -> String {
    let mut md = String::from(
        "| Position | Letter | Shard (dec) | Shard (hex) |\n\
         |----------|--------|-------------|-------------|\n",
    );
    for t in targets {
        md.push_str(&format!(
            "| {} | {} | {} | 0x{:02X} |\n",
            t.position, t.letter, t.shard_byte, t.shard_byte,
        ));
    }
    md
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Known DARKNULL nullifier vector.
    /// SHA256(bytes || epoch=0_le64 || "dark_null_v1")[0] == 68 == b'D'
    const KNOWN_D_NULLIFIER_HEX: &str =
        "61227192098dd2e1a2f2a887bbd2454cfa27330e224e7d59f1a9adf1eeb6dc89";

    fn darknull_input(method: PuzzleMethod) -> PuzzleCompileInput {
        PuzzleCompileInput {
            message: "DARKNULL".to_string(),
            method,
            target_network: "mainnet-beta".to_string(),
        }
    }

    // 1. Compile "DARKNULL" with ShardAscii — verify positions and shard bytes.
    #[test]
    fn test_compile_darknull_message() {
        let input = darknull_input(PuzzleMethod::ShardAscii);
        let output = compile_puzzle(&input).unwrap();
        assert_eq!(output.shard_targets.len(), 8);
        assert_eq!(output.shard_targets[0].letter, 'D');
        assert_eq!(output.shard_targets[0].shard_byte, 68); // b'D'
        assert_eq!(output.shard_targets[1].letter, 'A');
        assert_eq!(output.shard_targets[1].shard_byte, 65); // b'A'
        assert_eq!(output.shard_targets[4].letter, 'N');
        assert_eq!(output.shard_targets[4].shard_byte, 78); // b'N'
    }

    // 2. Known DARKNULL vector: verify nullifier satisfies ritual formula for 'D' (68).
    #[test]
    fn test_verify_known_darknull_nullifier() {
        let bytes = hex_to_bytes(KNOWN_D_NULLIFIER_HEX).unwrap();
        let result = verify_nullifier_for_shard(&bytes, 68, 0, b"dark_null_v1");
        assert!(
            result,
            "known DARKNULL nullifier must satisfy the ritual formula for 'D'"
        );
    }

    // 3. proof_markdown contains the required column headers.
    #[test]
    fn test_proof_markdown_generated() {
        let input = darknull_input(PuzzleMethod::ShardAscii);
        let output = compile_puzzle(&input).unwrap();
        assert!(output.proof_markdown.contains("Position"));
        assert!(output.proof_markdown.contains("Shard"));
    }

    // 4. decode_instructions references the ritual domain.
    #[test]
    fn test_decode_instructions_include_domain() {
        let input = darknull_input(PuzzleMethod::ShardAscii);
        let output = compile_puzzle(&input).unwrap();
        assert!(output.decode_instructions.contains("dark_null_v1"));
    }

    // 5. No private key or secret leaks in proof_markdown / decode_instructions.
    #[test]
    fn test_no_private_keys_in_output() {
        let input = darknull_input(PuzzleMethod::ShardAscii);
        let output = compile_puzzle(&input).unwrap();
        assert!(
            !output.proof_markdown.to_lowercase().contains("private_key"),
            "proof_markdown must not contain 'private_key'"
        );
        assert!(
            !output
                .decode_instructions
                .to_lowercase()
                .contains("private_key"),
            "decode_instructions must not contain 'private_key'"
        );
        assert!(
            !output.proof_markdown.to_lowercase().contains("secret"),
            "proof_markdown must not contain 'secret'"
        );
        assert!(
            !output.decode_instructions.to_lowercase().contains("secret"),
            "decode_instructions must not contain 'secret'"
        );
    }

    // 6. ASCII message → puzzle_score == 1.0.
    #[test]
    fn test_puzzle_score_computed() {
        let input = darknull_input(PuzzleMethod::ShardAscii);
        let output = compile_puzzle(&input).unwrap();
        assert!(
            (output.puzzle_score - 1.0_f32).abs() < f32::EPSILON,
            "expected puzzle_score 1.0, got {}",
            output.puzzle_score
        );
    }

    // 7. Empty message → PuzzleError::EmptyMessage.
    #[test]
    fn test_empty_message_rejected() {
        let input = PuzzleCompileInput {
            message: String::new(),
            method: PuzzleMethod::ShardAscii,
            target_network: "mainnet-beta".to_string(),
        };
        let result = compile_puzzle(&input);
        assert!(matches!(result, Err(PuzzleError::EmptyMessage)));
    }

    // 8. hex_to_bytes parses "68656c6c6f" correctly.
    #[test]
    fn test_hex_to_bytes_parses_correctly() {
        let result = hex_to_bytes("68656c6c6f").unwrap();
        assert_eq!(result, vec![0x68, 0x65, 0x6c, 0x6c, 0x6f]);
    }

    // 9. AltOrderCipher compiles "DARK" into 4 shard targets.
    #[test]
    fn test_alt_order_cipher_produces_output() {
        let input = PuzzleCompileInput {
            message: "DARK".to_string(),
            method: PuzzleMethod::AltOrderCipher,
            target_network: "mainnet-beta".to_string(),
        };
        let output = compile_puzzle(&input).unwrap();
        assert_eq!(output.shard_targets.len(), 4);
        assert_eq!(output.method, PuzzleMethod::AltOrderCipher);
    }

    // 10. "XYZ" → shard_bytes [88, 89, 90].
    #[test]
    fn test_shard_targets_match_ascii_values() {
        let input = PuzzleCompileInput {
            message: "XYZ".to_string(),
            method: PuzzleMethod::ShardAscii,
            target_network: "devnet".to_string(),
        };
        let output = compile_puzzle(&input).unwrap();
        let shard_bytes: Vec<u8> = output.shard_targets.iter().map(|t| t.shard_byte).collect();
        assert_eq!(shard_bytes, vec![88, 89, 90]);
    }

    // Bonus: sha256_domain is domain-separated (different domain → different hash).
    #[test]
    fn test_sha256_domain_separation() {
        let h1 = sha256_domain(b"domain_a", &[b"input"]);
        let h2 = sha256_domain(b"domain_b", &[b"input"]);
        assert_ne!(h1, h2);
    }

    // Bonus: hex_to_bytes rejects odd-length input.
    #[test]
    fn test_hex_to_bytes_rejects_odd_length() {
        let result = hex_to_bytes("abc");
        assert!(matches!(result, Err(PuzzleError::NonAsciiMessage)));
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_verify_nullifier_wrong_epoch_fails() {
        // The known D nullifier is valid for epoch=0 only; epoch=1 must fail.
        let bytes = hex_to_bytes(KNOWN_D_NULLIFIER_HEX).unwrap();
        let result = verify_nullifier_for_shard(&bytes, 68, 1, b"dark_null_v1");
        assert!(
            !result,
            "known DARKNULL nullifier must NOT satisfy ritual formula for epoch=1"
        );
    }

    #[test]
    fn test_shard_positions_sequential() {
        let input = darknull_input(PuzzleMethod::ShardAscii);
        let output = compile_puzzle(&input).unwrap();
        for (i, t) in output.shard_targets.iter().enumerate() {
            assert_eq!(t.position, i, "position must equal index {}", i);
        }
    }

    #[test]
    fn test_compile_alt_order_cipher_same_shard_bytes() {
        // Both ShardAscii and AltOrderCipher use ASCII value as shard_byte.
        let mk = |method: PuzzleMethod| PuzzleCompileInput {
            message: "DARK".to_string(),
            method,
            target_network: "devnet".to_string(),
        };
        let out_ascii = compile_puzzle(&mk(PuzzleMethod::ShardAscii)).unwrap();
        let out_alt = compile_puzzle(&mk(PuzzleMethod::AltOrderCipher)).unwrap();
        let bytes_ascii: Vec<u8> = out_ascii
            .shard_targets
            .iter()
            .map(|t| t.shard_byte)
            .collect();
        let bytes_alt: Vec<u8> = out_alt.shard_targets.iter().map(|t| t.shard_byte).collect();
        assert_eq!(
            bytes_ascii, bytes_alt,
            "both methods must produce identical shard_bytes for the same message"
        );
    }

    #[test]
    fn test_hex_to_bytes_uppercase() {
        let result = hex_to_bytes("AABB").unwrap();
        assert_eq!(result, vec![0xAAu8, 0xBB]);
    }
}
