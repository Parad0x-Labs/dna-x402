use sha2::{Digest, Sha256};

// ── Constants ─────────────────────────────────────────────────────────────────

pub const MAX_HOPS: u8 = 8;

// ── Types ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct RelayPacket {
    /// SHA256("relay-id-v1" || payload_commitment || route_commitment || [hop_count])
    pub packet_id: [u8; 32],
    /// SHA256("relay-payload-v1" || payload)
    pub payload_commitment: [u8; 32],
    /// Chain of route_hop calls
    pub route_commitment: [u8; 32],
    /// SHA256("relay-secret-v1" || relay_secrets[0])  (first hop's relay_hash)
    pub relay_hash: [u8; 32],
    pub hop_count: u8,
    pub delivered: bool,
    pub mainnet_ready: bool,
}

#[derive(Debug, PartialEq)]
pub enum RelayError {
    EmptyPayload,
    TooManyHops,
    ZeroRelaySecret,
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn sha256_parts(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

// ── Hash formulas ─────────────────────────────────────────────────────────────

pub fn payload_commitment(payload: &[u8]) -> [u8; 32] {
    sha256_parts(&[b"relay-payload-v1", payload])
}

pub fn relay_hash_fn(relay_secret: &[u8; 32]) -> [u8; 32] {
    sha256_parts(&[b"relay-secret-v1", relay_secret.as_ref()])
}

pub fn route_hop(prev_route: &[u8; 32], hop_idx: u8, rh: &[u8; 32]) -> [u8; 32] {
    sha256_parts(&[
        b"relay-hop-v1",
        prev_route.as_ref(),
        &[hop_idx],
        rh.as_ref(),
    ])
}

pub fn packet_id_hash(pc: &[u8; 32], rc: &[u8; 32], hop_count: u8) -> [u8; 32] {
    sha256_parts(&[b"relay-id-v1", pc.as_ref(), rc.as_ref(), &[hop_count]])
}

// ── Public API ────────────────────────────────────────────────────────────────

pub fn new_relay_packet(
    payload: &[u8],
    relay_secrets: &[[u8; 32]],
) -> Result<RelayPacket, RelayError> {
    if payload.is_empty() {
        return Err(RelayError::EmptyPayload);
    }
    if relay_secrets.len() > MAX_HOPS as usize {
        return Err(RelayError::TooManyHops);
    }
    for secret in relay_secrets {
        if secret == &[0u8; 32] {
            return Err(RelayError::ZeroRelaySecret);
        }
    }

    let pc = payload_commitment(payload);

    // Build route_commitment by chaining hops from payload_commitment
    let mut route = pc;
    for (i, secret) in relay_secrets.iter().enumerate() {
        let rh = relay_hash_fn(secret);
        route = route_hop(&route, i as u8, &rh);
    }
    let rc = route;

    let hop_count = relay_secrets.len() as u8;
    let pid = packet_id_hash(&pc, &rc, hop_count);

    // relay_hash is the first hop's relay_hash (or zero if no hops)
    let first_relay_hash = if relay_secrets.is_empty() {
        [0u8; 32]
    } else {
        relay_hash_fn(&relay_secrets[0])
    };

    Ok(RelayPacket {
        packet_id: pid,
        payload_commitment: pc,
        route_commitment: rc,
        relay_hash: first_relay_hash,
        hop_count,
        delivered: false,
        mainnet_ready: false,
    })
}

pub fn deliver_packet(packet: &mut RelayPacket) -> [u8; 32] {
    packet.delivered = true;
    packet.packet_id
}

pub fn verify_packet(packet: &RelayPacket) -> bool {
    packet.packet_id != [0u8; 32]
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    const PAYLOAD: &[u8] = b"proof-data-xyz";
    const SECRET1: [u8; 32] = [0x01u8; 32];
    const SECRET2: [u8; 32] = [0x02u8; 32];
    const SECRET3: [u8; 32] = [0x03u8; 32];

    #[test]
    fn new_relay_packet_correct_formulas() {
        let secrets = [SECRET1, SECRET2, SECRET3];
        let packet = new_relay_packet(PAYLOAD, &secrets).unwrap();

        // Verify payload_commitment
        let expected_pc = payload_commitment(PAYLOAD);
        assert_eq!(packet.payload_commitment, expected_pc);

        // Verify hop_count
        assert_eq!(packet.hop_count, 3);

        // packet_id should be non-zero
        assert_ne!(packet.packet_id, [0u8; 32]);
        assert!(!packet.mainnet_ready);
    }

    #[test]
    fn deliver_sets_delivered_true() {
        let mut packet = new_relay_packet(PAYLOAD, &[SECRET1]).unwrap();
        assert!(!packet.delivered);
        let returned_id = deliver_packet(&mut packet);
        assert!(packet.delivered);
        assert_eq!(returned_id, packet.packet_id);
    }

    #[test]
    fn verify_returns_true() {
        let packet = new_relay_packet(PAYLOAD, &[SECRET1, SECRET2]).unwrap();
        assert!(verify_packet(&packet));
    }

    #[test]
    fn too_many_hops_rejected() {
        let secrets: Vec<[u8; 32]> = (1u8..=(MAX_HOPS + 1)).map(|i| [i; 32]).collect();
        let result = new_relay_packet(PAYLOAD, &secrets);
        assert_eq!(result.unwrap_err(), RelayError::TooManyHops);
    }

    #[test]
    fn empty_payload_rejected() {
        let result = new_relay_packet(b"", &[SECRET1]);
        assert_eq!(result.unwrap_err(), RelayError::EmptyPayload);
    }

    #[test]
    fn mainnet_ready_is_false() {
        let packet = new_relay_packet(PAYLOAD, &[SECRET1]).unwrap();
        assert!(!packet.mainnet_ready);
    }
}
