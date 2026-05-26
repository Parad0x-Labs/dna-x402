use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

// ── Types ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Lottery {
    pub lottery_id: [u8; 32],
    pub organizer_hash: [u8; 32],
    pub ticket_root: [u8; 32],
    pub prize_commitment: [u8; 32],
    pub ticket_count: u32,
    pub drawn: bool,
    pub winner_commitment: [u8; 32],
    pub mainnet_ready: bool,
    #[serde(skip)]
    ticket_ids: Vec<[u8; 32]>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Ticket {
    pub ticket_id: [u8; 32],
    pub holder_hash: [u8; 32],
    pub serial_hash: [u8; 32],
    pub mainnet_ready: bool,
}

#[derive(Debug, PartialEq)]
pub enum LotteryError {
    ZeroOrganizerSecret,
    ZeroHolderSecret,
    AlreadyDrawn,
    NoTickets,
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

fn xor_fold(hashes: &[[u8; 32]]) -> [u8; 32] {
    let mut acc = [0u8; 32];
    for h in hashes {
        for i in 0..32 {
            acc[i] ^= h[i];
        }
    }
    acc
}

fn compute_organizer_hash(secret: &[u8; 32]) -> [u8; 32] {
    sha256_multi(&[b"lottery-org-v1", secret])
}

fn compute_prize_commitment(organizer_hash: &[u8; 32], prize: u64) -> [u8; 32] {
    sha256_multi(&[b"lottery-prize-v1", organizer_hash, &prize.to_le_bytes()])
}

fn compute_lottery_id(
    organizer_hash: &[u8; 32],
    prize_commitment: &[u8; 32],
    nonce: &[u8; 32],
) -> [u8; 32] {
    sha256_multi(&[b"lottery-id-v1", organizer_hash, prize_commitment, nonce])
}

fn compute_holder_hash(holder_secret: &[u8; 32]) -> [u8; 32] {
    sha256_multi(&[b"lottery-holder-v1", holder_secret])
}

fn compute_serial_hash(
    lottery_id: &[u8; 32],
    holder_hash: &[u8; 32],
    serial_nonce: &[u8; 32],
) -> [u8; 32] {
    sha256_multi(&[b"lottery-serial-v1", lottery_id, holder_hash, serial_nonce])
}

fn compute_ticket_id(serial_hash: &[u8; 32], holder_hash: &[u8; 32]) -> [u8; 32] {
    sha256_multi(&[b"lottery-ticket-v1", serial_hash, holder_hash])
}

fn compute_ticket_root(ticket_ids: &[[u8; 32]], ticket_count: u32) -> [u8; 32] {
    let folded = xor_fold(ticket_ids);
    sha256_multi(&[b"lottery-root-v1", &folded, &ticket_count.to_le_bytes()])
}

fn compute_winner_commitment(ticket_id: &[u8; 32]) -> [u8; 32] {
    sha256_multi(&[b"lottery-winner-v1", ticket_id])
}

// ── API ────────────────────────────────────────────────────────────────────

pub fn create_lottery(
    organizer_secret: &[u8; 32],
    prize: u64,
    nonce: &[u8; 32],
) -> Result<Lottery, LotteryError> {
    if organizer_secret == &[0u8; 32] {
        return Err(LotteryError::ZeroOrganizerSecret);
    }
    let organizer_hash = compute_organizer_hash(organizer_secret);
    let prize_commitment = compute_prize_commitment(&organizer_hash, prize);
    let lottery_id = compute_lottery_id(&organizer_hash, &prize_commitment, nonce);
    let ticket_root = compute_ticket_root(&[], 0);
    Ok(Lottery {
        lottery_id,
        organizer_hash,
        ticket_root,
        prize_commitment,
        ticket_count: 0,
        drawn: false,
        winner_commitment: [0u8; 32],
        mainnet_ready: false,
        ticket_ids: Vec::new(),
    })
}

pub fn buy_ticket(
    lottery: &mut Lottery,
    holder_secret: &[u8; 32],
    serial_nonce: &[u8; 32],
) -> Result<Ticket, LotteryError> {
    if lottery.drawn {
        return Err(LotteryError::AlreadyDrawn);
    }
    if holder_secret == &[0u8; 32] {
        return Err(LotteryError::ZeroHolderSecret);
    }
    let holder_hash = compute_holder_hash(holder_secret);
    let serial_hash = compute_serial_hash(&lottery.lottery_id, &holder_hash, serial_nonce);
    let ticket_id = compute_ticket_id(&serial_hash, &holder_hash);
    lottery.ticket_ids.push(ticket_id);
    lottery.ticket_count += 1;
    lottery.ticket_root = compute_ticket_root(&lottery.ticket_ids, lottery.ticket_count);
    Ok(Ticket {
        ticket_id,
        holder_hash,
        serial_hash,
        mainnet_ready: false,
    })
}

pub fn draw_winner(lottery: &mut Lottery) -> Result<[u8; 32], LotteryError> {
    if lottery.drawn {
        return Err(LotteryError::AlreadyDrawn);
    }
    if lottery.ticket_ids.is_empty() {
        return Err(LotteryError::NoTickets);
    }
    // Deterministic: first ticket is winner
    let winner_commitment = compute_winner_commitment(&lottery.ticket_ids[0]);
    lottery.winner_commitment = winner_commitment;
    lottery.drawn = true;
    Ok(winner_commitment)
}

pub fn lottery_public_record(lottery: &Lottery) -> String {
    serde_json::json!({
        "lottery_id":    hex32(&lottery.lottery_id),
        "ticket_count":  lottery.ticket_count,
        "drawn":         lottery.drawn,
        "mainnet_ready": lottery.mainnet_ready,
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

    // Test 1: create + buy + draw
    #[test]
    fn test_create_buy_draw() {
        let mut lottery = create_lottery(&secret(0x11), 10_000, &nonce(0x01)).unwrap();
        assert!(!lottery.mainnet_ready);
        let ticket = buy_ticket(&mut lottery, &secret(0x22), &nonce(0x02)).unwrap();
        assert!(!ticket.mainnet_ready);
        assert_eq!(lottery.ticket_count, 1);
        let winner = draw_winner(&mut lottery).unwrap();
        assert!(lottery.drawn);
        assert_eq!(winner, lottery.winner_commitment);
    }

    // Test 2: no tickets rejected
    #[test]
    fn test_no_tickets_rejected() {
        let mut lottery = create_lottery(&secret(0x11), 5_000, &nonce(0x01)).unwrap();
        let err = draw_winner(&mut lottery).unwrap_err();
        assert_eq!(err, LotteryError::NoTickets);
    }

    // Test 3: already drawn rejected
    #[test]
    fn test_already_drawn_rejected() {
        let mut lottery = create_lottery(&secret(0x11), 5_000, &nonce(0x01)).unwrap();
        buy_ticket(&mut lottery, &secret(0x22), &nonce(0x02)).unwrap();
        draw_winner(&mut lottery).unwrap();
        let err = draw_winner(&mut lottery).unwrap_err();
        assert_eq!(err, LotteryError::AlreadyDrawn);
        // Also cannot buy after draw
        let err2 = buy_ticket(&mut lottery, &secret(0x33), &nonce(0x03)).unwrap_err();
        assert_eq!(err2, LotteryError::AlreadyDrawn);
    }

    // Test 4: zero organizer rejected
    #[test]
    fn test_zero_organizer_rejected() {
        let err = create_lottery(&[0u8; 32], 1_000, &nonce(0x01)).unwrap_err();
        assert_eq!(err, LotteryError::ZeroOrganizerSecret);
    }

    // Test 5: ticket_id deterministic
    #[test]
    fn test_ticket_id_deterministic() {
        let lottery1 = create_lottery(&secret(0x11), 1_000, &nonce(0x01)).unwrap();
        let lottery2 = create_lottery(&secret(0x11), 1_000, &nonce(0x01)).unwrap();
        assert_eq!(lottery1.lottery_id, lottery2.lottery_id);
        // Buy same ticket in both
        let mut l1 = lottery1;
        let mut l2 = lottery2;
        let t1 = buy_ticket(&mut l1, &secret(0x22), &nonce(0x02)).unwrap();
        let t2 = buy_ticket(&mut l2, &secret(0x22), &nonce(0x02)).unwrap();
        assert_eq!(t1.ticket_id, t2.ticket_id);
    }

    // Test 6: public record hides organizer
    #[test]
    fn test_public_record_hides_organizer() {
        let lottery = create_lottery(&secret(0x55), 1_000, &nonce(0x01)).unwrap();
        let record = lottery_public_record(&lottery);
        let v: serde_json::Value = serde_json::from_str(&record).unwrap();
        assert!(v["lottery_id"].is_string());
        assert_eq!(v["ticket_count"], 0);
        assert_eq!(v["drawn"], false);
        assert_eq!(v["mainnet_ready"], false);
        // organizer_hash must NOT appear
        assert!(v.get("organizer_hash").is_none());
    }
}
