//! Minimal SPL Token (classic program) support: instruction encoding and
//! token account parsing, without the spl-token crate. Token-2022 mints are
//! not accepted (a transfer-fee extension would break the prize accounting).

use solana_program::{
    account_info::AccountInfo,
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
};

/// The classic SPL Token program.
pub const TOKEN_PROGRAM_ID: Pubkey = solana_program::pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
/// Token account size.
pub const ACCOUNT_LEN: usize = 165;
/// Mint account size.
pub const MINT_LEN: usize = 82;

/// Parsed fields of an initialized, unfrozen token account.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TokenAccount {
    pub mint: [u8; 32],
    pub owner: [u8; 32],
    pub amount: u64,
}

/// Parse a token account owned by the classic Token program (state must be
/// Initialized, not Frozen).
pub fn read_account(ai: &AccountInfo) -> Option<TokenAccount> {
    if *ai.owner != TOKEN_PROGRAM_ID {
        return None;
    }
    let d = ai.try_borrow_data().ok()?;
    if d.len() != ACCOUNT_LEN || d[108] != 1 {
        return None;
    }
    let mut mint = [0u8; 32];
    mint.copy_from_slice(&d[0..32]);
    let mut owner = [0u8; 32];
    owner.copy_from_slice(&d[32..64]);
    let mut a = [0u8; 8];
    a.copy_from_slice(&d[64..72]);
    Some(TokenAccount { mint, owner, amount: u64::from_le_bytes(a) })
}

/// `Transfer` (tag 3).
pub fn transfer(source: &Pubkey, dest: &Pubkey, authority: &Pubkey, amount: u64) -> Instruction {
    let mut data = vec![3u8];
    data.extend_from_slice(&amount.to_le_bytes());
    Instruction {
        program_id: TOKEN_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*source, false),
            AccountMeta::new(*dest, false),
            AccountMeta::new_readonly(*authority, true),
        ],
        data,
    }
}

/// `InitializeAccount3` (tag 18): no rent sysvar needed.
pub fn initialize_account3(account: &Pubkey, mint: &Pubkey, owner: &Pubkey) -> Instruction {
    let mut data = vec![18u8];
    data.extend_from_slice(owner.as_ref());
    Instruction {
        program_id: TOKEN_PROGRAM_ID,
        accounts: vec![AccountMeta::new(*account, false), AccountMeta::new_readonly(*mint, false)],
        data,
    }
}

/// `CloseAccount` (tag 9).
pub fn close_account(account: &Pubkey, dest: &Pubkey, owner: &Pubkey) -> Instruction {
    Instruction {
        program_id: TOKEN_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*account, false),
            AccountMeta::new(*dest, false),
            AccountMeta::new_readonly(*owner, true),
        ],
        data: vec![9u8],
    }
}

/// Off-chain / test helper: bytes of an initialized token account.
pub fn pack_account(mint: &Pubkey, owner: &Pubkey, amount: u64) -> Vec<u8> {
    let mut d = vec![0u8; ACCOUNT_LEN];
    d[0..32].copy_from_slice(mint.as_ref());
    d[32..64].copy_from_slice(owner.as_ref());
    d[64..72].copy_from_slice(&amount.to_le_bytes());
    d[108] = 1;
    d
}

/// Off-chain / test helper: bytes of an initialized mint without authorities.
pub fn pack_mint(supply: u64, decimals: u8) -> Vec<u8> {
    let mut d = vec![0u8; MINT_LEN];
    d[36..44].copy_from_slice(&supply.to_le_bytes());
    d[44] = decimals;
    d[45] = 1;
    d
}
