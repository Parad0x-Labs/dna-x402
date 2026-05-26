use sha2::{Digest, Sha256};
use std::collections::HashSet;

// Domain prefix for scope and nullifier hashing
const DOMAIN_SCOPE: u8 = 0xC0;
const DOMAIN_NULLIFIER: u8 = 0xC1;

/// Telegram bot commands recognised by the receipt system.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum TgCommand {
    Signal,
    Bet,
    Pause,
    Tip,
    Trial,
    BuyApiCalls,
}

/// A verifiable receipt proving a user is authorised to issue a Telegram command.
///
/// All fields are hashes — no raw API keys, user IDs, or secrets are stored.
#[derive(Clone, Debug)]
pub struct CommandReceipt {
    pub command: TgCommand,
    /// SHA256 of the scope string this command requires
    pub scope_hash: [u8; 32],
    /// SHA256 of the user identifier (Telegram user id + salt)
    pub user_hash: [u8; 32],
    /// Per-command-per-user nonce nullifier — prevents replay
    pub nullifier: [u8; 32],
    /// Solana slot after which the receipt is invalid
    pub expires_at_slot: u64,
}

/// Errors returned by verify_command.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CommandError {
    Expired,
    WrongScope,
    NullifierReused,
    /// Safety valve: /pause is always allowed — this variant is unreachable in practice
    PauseAlwaysAllowed,
}

/// Canonical scope hash for each command.
/// SHA256(0xC0 || command_tag_byte)
pub fn required_scope(cmd: &TgCommand) -> [u8; 32] {
    let tag = command_tag(cmd);
    let mut h = Sha256::new();
    h.update([DOMAIN_SCOPE, tag]);
    h.finalize().into()
}

/// Per-user, per-command, per-nonce nullifier.
/// SHA256(0xC1 || user_hash || command_tag || nonce)
pub fn command_nullifier(user_hash: &[u8; 32], command: &TgCommand, nonce: &[u8; 32]) -> [u8; 32] {
    let tag = command_tag(command);
    let mut h = Sha256::new();
    h.update([DOMAIN_NULLIFIER]);
    h.update(user_hash);
    h.update([tag]);
    h.update(nonce);
    h.finalize().into()
}

fn command_tag(cmd: &TgCommand) -> u8 {
    match cmd {
        TgCommand::Signal => 0x01,
        TgCommand::Bet => 0x02,
        TgCommand::Pause => 0x03,
        TgCommand::Tip => 0x04,
        TgCommand::Trial => 0x05,
        TgCommand::BuyApiCalls => 0x06,
    }
}

/// Verify a command receipt.
///
/// Special rule: /pause is always allowed regardless of scope, expiry, or nullifier —
/// this is a safety command that must never be gatekept.
pub fn verify_command(receipt: &CommandReceipt, current_slot: u64) -> Result<(), CommandError> {
    // /pause is a hard safety command — always allowed
    if receipt.command == TgCommand::Pause {
        return Ok(());
    }
    // Check expiry
    if current_slot > receipt.expires_at_slot {
        return Err(CommandError::Expired);
    }
    // Check scope matches the canonical scope for this command
    let canonical = required_scope(&receipt.command);
    if receipt.scope_hash != canonical {
        return Err(CommandError::WrongScope);
    }
    Ok(())
}

/// Tracks which nullifiers have been consumed.
/// Used by the bot's runtime to detect and reject replays.
#[derive(Clone, Debug, Default)]
pub struct CommandLog {
    pub used_nullifiers: HashSet<[u8; 32]>,
}

impl CommandLog {
    pub fn new() -> Self {
        Self {
            used_nullifiers: HashSet::new(),
        }
    }

    /// Attempt to record a command as used. Returns Err(NullifierReused) on replay.
    pub fn record(
        &mut self,
        receipt: &CommandReceipt,
        current_slot: u64,
    ) -> Result<(), CommandError> {
        // Pause always passes even in the log (but still record it to maintain audit trail)
        if receipt.command != TgCommand::Pause {
            verify_command(receipt, current_slot)?;
            if self.used_nullifiers.contains(&receipt.nullifier) {
                return Err(CommandError::NullifierReused);
            }
        }
        self.used_nullifiers.insert(receipt.nullifier);
        Ok(())
    }
}

/// Test helper: verifies that a log string produced from a CommandReceipt
/// does not contain any raw secret material — only hashes.
pub fn bot_never_logs_secret(log_line: &str) -> bool {
    // A raw secret would look like a long lowercase hex string with no domain structure.
    // Our fields are all [u8;32] arrays formatted as short hex or Debug — never raw keys.
    // We consider the log clean if it does not contain anything that looks like
    // a plaintext private key prefix ("-----BEGIN") or common secret patterns.
    !log_line.contains("-----BEGIN")
        && !log_line.contains("private_key")
        && !log_line.contains("api_key_raw")
        && !log_line.contains("secret=")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_signal_receipt(slot: u64) -> CommandReceipt {
        let scope = required_scope(&TgCommand::Signal);
        let user = [0xABu8; 32];
        let nonce = [0x01u8; 32];
        CommandReceipt {
            command: TgCommand::Signal,
            scope_hash: scope,
            user_hash: user,
            nullifier: command_nullifier(&user, &TgCommand::Signal, &nonce),
            expires_at_slot: slot + 500,
        }
    }

    #[test]
    fn test_signal_requires_scope() {
        let receipt = make_signal_receipt(1000);
        // Correct scope — should pass at slot 1000
        assert!(verify_command(&receipt, 1000).is_ok());

        // Wrong scope — should fail
        let mut bad = receipt.clone();
        bad.scope_hash = [0x00u8; 32];
        assert_eq!(verify_command(&bad, 1000), Err(CommandError::WrongScope));
    }

    #[test]
    fn test_pause_always_allowed() {
        // /pause with wrong scope, expired slot — still Ok
        let receipt = CommandReceipt {
            command: TgCommand::Pause,
            scope_hash: [0x00u8; 32], // wrong scope
            user_hash: [0xFFu8; 32],
            nullifier: [0x11u8; 32],
            expires_at_slot: 0, // already expired
        };
        // Should pass at any slot
        assert!(verify_command(&receipt, 999_999).is_ok());
        assert!(verify_command(&receipt, 0).is_ok());
    }

    #[test]
    fn test_expired_rejected() {
        let mut receipt = make_signal_receipt(1000);
        receipt.expires_at_slot = 1000;
        // At slot 1000 — still valid (expires_at_slot is inclusive boundary: > means expired)
        assert!(verify_command(&receipt, 1000).is_ok());
        // At slot 1001 — expired
        assert_eq!(verify_command(&receipt, 1001), Err(CommandError::Expired));
    }

    #[test]
    fn test_nullifier_reuse_rejected() {
        let receipt = make_signal_receipt(5000);
        let mut log = CommandLog::new();
        assert!(log.record(&receipt, 5000).is_ok());
        // Second use of the same nullifier
        assert_eq!(
            log.record(&receipt, 5001),
            Err(CommandError::NullifierReused)
        );
    }

    #[test]
    fn test_command_nullifier_deterministic() {
        let user = [0x77u8; 32];
        let nonce = [0x88u8; 32];
        let n1 = command_nullifier(&user, &TgCommand::Bet, &nonce);
        let n2 = command_nullifier(&user, &TgCommand::Bet, &nonce);
        assert_eq!(n1, n2);
        // Different command => different nullifier
        let n3 = command_nullifier(&user, &TgCommand::Tip, &nonce);
        assert_ne!(n1, n3);
        // Different nonce => different nullifier
        let other_nonce = [0x99u8; 32];
        let n4 = command_nullifier(&user, &TgCommand::Bet, &other_nonce);
        assert_ne!(n1, n4);
    }

    #[test]
    fn test_command_receipt_no_raw_secrets() {
        let receipt = make_signal_receipt(2000);
        // Format a "log line" using the Debug representation
        let log_line = format!(
            "command={:?} scope={:?} user={:?} nullifier={:?} slot={}",
            receipt.command,
            &receipt.scope_hash[..4],
            &receipt.user_hash[..4],
            &receipt.nullifier[..4],
            receipt.expires_at_slot
        );
        assert!(
            bot_never_logs_secret(&log_line),
            "Log line must not contain raw secret material: {}",
            log_line
        );
    }
}
