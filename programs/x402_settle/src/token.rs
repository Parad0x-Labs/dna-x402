//! Minimal SPL Token / Token-2022 support: mint checks with the extension
//! allowlist, token account reads and the two instructions the program
//! issues (InitializeAccount3, TransferChecked). Built by hand so the program
//! depends only on solana-program.

use crate::error::XsError;
use solana_program::{
    account_info::AccountInfo,
    instruction::{AccountMeta, Instruction},
    program_error::ProgramError,
    pubkey,
    pubkey::Pubkey,
};

pub const TOKEN_ID: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const TOKEN_2022_ID: Pubkey = pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

pub const MINT_BASE_LEN: usize = 82;
pub const ACCOUNT_LEN: usize = 165;
/// Upper bound on the TLV entries read from a Token-2022 mint.
pub const MAX_MINT_EXTENSIONS: usize = 32;

/// Token-2022 mint extensions that leave raw transfer amounts and vault
/// custody unchanged: MintCloseAuthority (3), MetadataPointer (18),
/// TokenMetadata (19), GroupPointer (20), TokenGroup (21),
/// GroupMemberPointer (22), TokenGroupMember (23). Everything else is refused,
/// among them TransferFee (amount changes in flight), PermanentDelegate (can
/// move vault tokens), TransferHook (extra accounts and code on every
/// transfer), NonTransferable, DefaultAccountState, ConfidentialTransfer,
/// InterestBearing, ScaledUiAmount and Pausable.
pub const ALLOWED_MINT_EXTENSIONS: [u16; 7] = [3, 18, 19, 20, 21, 22, 23];

/// Checks the mint and returns its decimals.
pub fn check_mint(mint: &AccountInfo, token_program: &Pubkey) -> Result<u8, ProgramError> {
    if mint.owner != token_program {
        return Err(XsError::MintNotAllowed.into());
    }
    let d = mint.try_borrow_data()?;
    if d.len() < MINT_BASE_LEN || d[45] != 1 {
        return Err(XsError::MintNotAllowed.into());
    }
    let decimals = d[44];
    if d.len() == MINT_BASE_LEN {
        return Ok(decimals);
    }
    if *token_program != TOKEN_2022_ID {
        return Err(XsError::MintNotAllowed.into());
    }
    // Token-2022 extended mint: base padded to 165, account type byte, TLV.
    if d.len() < ACCOUNT_LEN + 1 || d[ACCOUNT_LEN] != 1 {
        return Err(XsError::MintNotAllowed.into());
    }
    let mut o = ACCOUNT_LEN + 1;
    let mut n = 0usize;
    while o + 4 <= d.len() {
        let ty = u16::from_le_bytes([d[o], d[o + 1]]);
        let len = u16::from_le_bytes([d[o + 2], d[o + 3]]) as usize;
        if ty == 0 {
            break; // uninitialized tail
        }
        n += 1;
        if n > MAX_MINT_EXTENSIONS || !ALLOWED_MINT_EXTENSIONS.contains(&ty) {
            return Err(XsError::MintNotAllowed.into());
        }
        o = o.checked_add(4 + len).ok_or(XsError::MintNotAllowed)?;
    }
    Ok(decimals)
}

/// Amount of an SPL token account (owner and address checked by the caller).
pub fn account_amount(d: &[u8]) -> Result<u64, ProgramError> {
    if d.len() < ACCOUNT_LEN {
        return Err(XsError::InvalidAccount.into());
    }
    let mut b = [0u8; 8];
    b.copy_from_slice(&d[64..72]);
    Ok(u64::from_le_bytes(b))
}

pub fn initialize_account3(token_program: &Pubkey, account: &Pubkey, mint: &Pubkey, owner: &Pubkey) -> Instruction {
    let mut data = Vec::with_capacity(33);
    data.push(18);
    data.extend_from_slice(owner.as_ref());
    Instruction {
        program_id: *token_program,
        accounts: vec![AccountMeta::new(*account, false), AccountMeta::new_readonly(*mint, false)],
        data,
    }
}

pub fn transfer_checked(
    token_program: &Pubkey,
    source: &Pubkey,
    mint: &Pubkey,
    destination: &Pubkey,
    authority: &Pubkey,
    amount: u64,
    decimals: u8,
) -> Instruction {
    let mut data = Vec::with_capacity(10);
    data.push(12);
    data.extend_from_slice(&amount.to_le_bytes());
    data.push(decimals);
    Instruction {
        program_id: *token_program,
        accounts: vec![
            AccountMeta::new(*source, false),
            AccountMeta::new_readonly(*mint, false),
            AccountMeta::new(*destination, false),
            AccountMeta::new_readonly(*authority, true),
        ],
        data,
    }
}
