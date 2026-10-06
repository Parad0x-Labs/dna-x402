//! Canonical ETH -> Solana agent binding message.
//!
//! The ETH key signs this message with EIP-191 `personal_sign`, so a wallet such
//! as MetaMask can produce the signature directly. The secp256k1 precompile at
//! transaction index 0 must carry exactly these bytes as its message:
//!
//! ```text
//! "\x19Ethereum Signed Message:\n" || decimal(len(body)) || body
//! ```
//!
//! and `body` is (lines separated by '\n', no trailing newline):
//!
//! ```text
//! dark-secp256k1-auth v1: bind ETH address to Solana agent
//! program: <base58 program id>
//! agent: <base58 agent pubkey>
//! eth: 0x<20-byte ETH address, lowercase hex>
//! domain: <domain_hash, lowercase hex>
//! auth: <auth_hash, lowercase hex>
//! ```
//!
//! RegisterEthAgent rebuilds the message from the program id, the agent signer
//! of the transaction, the ETH address in pda_seed and the domain_hash /
//! auth_hash in the instruction, and requires the precompile-verified message to
//! equal it. A signature made for one agent, program or domain therefore cannot
//! bind the ETH address to another one.

use solana_program::pubkey::Pubkey;

/// First line of the body: the domain separation tag.
pub const DOMAIN_TAG: &[u8] = b"dark-secp256k1-auth v1: bind ETH address to Solana agent";
/// EIP-191 version 0x45 (`personal_sign`) prefix.
pub const EIP191_PREFIX: &[u8] = b"\x19Ethereum Signed Message:\n";

const B58_ALPHABET: &[u8; 58] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const HEX: &[u8; 16] = b"0123456789abcdef";

fn push_hex(out: &mut Vec<u8>, bytes: &[u8]) {
    for b in bytes {
        out.push(HEX[(b >> 4) as usize]);
        out.push(HEX[(b & 0x0f) as usize]);
    }
}

/// Base58 (Bitcoin alphabet) of a 32-byte key, as printed by `Pubkey::to_string`.
fn push_base58_32(out: &mut Vec<u8>, input: &[u8; 32]) {
    // 32 bytes need at most 44 base58 digits.
    let mut digits = [0u8; 48];
    let mut len = 0usize;
    for &byte in input.iter() {
        let mut carry = byte as u32;
        for d in digits[..len].iter_mut() {
            carry += (*d as u32) << 8;
            *d = (carry % 58) as u8;
            carry /= 58;
        }
        while carry > 0 {
            digits[len] = (carry % 58) as u8;
            len += 1;
            carry /= 58;
        }
    }
    for &byte in input.iter() {
        if byte != 0 {
            break;
        }
        out.push(b'1');
    }
    for d in digits[..len].iter().rev() {
        out.push(B58_ALPHABET[*d as usize]);
    }
}

fn push_decimal(out: &mut Vec<u8>, mut n: usize) {
    let mut buf = [0u8; 20];
    let mut i = buf.len();
    loop {
        i -= 1;
        buf[i] = b'0' + (n % 10) as u8;
        n /= 10;
        if n == 0 {
            break;
        }
    }
    out.extend_from_slice(&buf[i..]);
}

/// The text the ETH key signs (without the EIP-191 prefix).
pub fn binding_body(
    program_id:  &Pubkey,
    agent:       &Pubkey,
    eth_address: &[u8; 20],
    domain_hash: &[u8; 32],
    auth_hash:   &[u8; 32],
) -> Vec<u8> {
    let mut body = Vec::with_capacity(340);
    body.extend_from_slice(DOMAIN_TAG);
    body.extend_from_slice(b"\nprogram: ");
    push_base58_32(&mut body, &program_id.to_bytes());
    body.extend_from_slice(b"\nagent: ");
    push_base58_32(&mut body, &agent.to_bytes());
    body.extend_from_slice(b"\neth: 0x");
    push_hex(&mut body, eth_address);
    body.extend_from_slice(b"\ndomain: ");
    push_hex(&mut body, domain_hash);
    body.extend_from_slice(b"\nauth: ");
    push_hex(&mut body, auth_hash);
    body
}

/// The exact message bytes the secp256k1 precompile must verify:
/// EIP-191 prefix || decimal body length || body.
pub fn binding_message(
    program_id:  &Pubkey,
    agent:       &Pubkey,
    eth_address: &[u8; 20],
    domain_hash: &[u8; 32],
    auth_hash:   &[u8; 32],
) -> Vec<u8> {
    let body = binding_body(program_id, agent, eth_address, domain_hash, auth_hash);
    let mut msg = Vec::with_capacity(EIP191_PREFIX.len() + 3 + body.len());
    msg.extend_from_slice(EIP191_PREFIX);
    push_decimal(&mut msg, body.len());
    msg.extend_from_slice(&body);
    msg
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base58_matches_pubkey_display() {
        let mut keys = vec![Pubkey::new_from_array([0u8; 32]), Pubkey::new_from_array([0xFFu8; 32])];
        let mut lead0 = [7u8; 32];
        lead0[0] = 0;
        lead0[1] = 0;
        keys.push(Pubkey::new_from_array(lead0));
        for _ in 0..64 {
            keys.push(Pubkey::new_unique());
        }
        keys.push(solana_program::system_program::id());
        keys.push(solana_program::sysvar::instructions::id());
        for k in keys {
            let mut out = Vec::new();
            push_base58_32(&mut out, &k.to_bytes());
            assert_eq!(String::from_utf8(out).unwrap(), k.to_string());
        }
    }

    #[test]
    fn message_layout() {
        let program = Pubkey::new_unique();
        let agent = Pubkey::new_unique();
        let eth = [0xABu8; 20];
        let body = binding_body(&program, &agent, &eth, &[0x01; 32], &[0x02; 32]);
        let text = String::from_utf8(body.clone()).unwrap();
        let expected = format!(
            "dark-secp256k1-auth v1: bind ETH address to Solana agent\nprogram: {}\nagent: {}\neth: 0x{}\ndomain: {}\nauth: {}",
            program, agent, "ab".repeat(20), "01".repeat(32), "02".repeat(32),
        );
        assert_eq!(text, expected);

        let msg = binding_message(&program, &agent, &eth, &[0x01; 32], &[0x02; 32]);
        let prefix = format!("\x19Ethereum Signed Message:\n{}", body.len());
        assert_eq!(&msg[..prefix.len()], prefix.as_bytes());
        assert_eq!(&msg[prefix.len()..], &body[..]);
    }

    #[test]
    fn message_commits_to_every_field() {
        let p = Pubkey::new_unique();
        let a = Pubkey::new_unique();
        let base = binding_message(&p, &a, &[1; 20], &[2; 32], &[3; 32]);
        assert_ne!(base, binding_message(&Pubkey::new_unique(), &a, &[1; 20], &[2; 32], &[3; 32]));
        assert_ne!(base, binding_message(&p, &Pubkey::new_unique(), &[1; 20], &[2; 32], &[3; 32]));
        assert_ne!(base, binding_message(&p, &a, &[9; 20], &[2; 32], &[3; 32]));
        assert_ne!(base, binding_message(&p, &a, &[1; 20], &[9; 32], &[3; 32]));
        assert_ne!(base, binding_message(&p, &a, &[1; 20], &[2; 32], &[9; 32]));
    }

    #[test]
    fn decimal() {
        for n in [0usize, 7, 10, 99, 334, 1000, 65535] {
            let mut out = Vec::new();
            push_decimal(&mut out, n);
            assert_eq!(String::from_utf8(out).unwrap(), n.to_string());
        }
    }
}
