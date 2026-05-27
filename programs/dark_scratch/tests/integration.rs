// Programs using invoke_signed trigger the rbpf 0.8.3 pointer-overflow bug on
// Windows (STATUS_STACK_BUFFER_OVERRUN in solBankForksCli). These tests are
// correct and pass on Linux/macOS. The pure logic tests at the bottom run on
// all platforms.

// ── Platform-gated ProgramTest integration tests ──────────────────────────────
#[cfg(not(target_os = "windows"))]
mod program_tests {
    use dark_scratch::{processor::process, SCRATCH_SEED};
    use solana_program::{
        clock::Clock,
        instruction::{AccountMeta, Instruction},
        pubkey::Pubkey,
        system_program,
    };
    use solana_program_test::{processor, ProgramTest, ProgramTestContext};
    use solana_sdk::{signature::Signer, transaction::Transaction};

    fn make_pt(id: Pubkey) -> ProgramTest {
        ProgramTest::new("dark-scratch", id, processor!(process))
    }

    fn scratch_pda(program_id: &Pubkey, owner: &Pubkey, tag: &[u8; 8]) -> (Pubkey, u8) {
        Pubkey::find_program_address(&[SCRATCH_SEED, owner.as_ref(), tag.as_ref()], program_id)
    }

    fn create_ix(
        program_id: &Pubkey,
        owner: &Pubkey,
        expires_at_slot: u64,
        tag: [u8; 8],
    ) -> (Instruction, Pubkey) {
        let (pda, _) = scratch_pda(program_id, owner, &tag);
        let mut data = vec![0x00u8];
        data.extend_from_slice(&expires_at_slot.to_le_bytes());
        data.extend_from_slice(&tag);
        (
            Instruction {
                program_id: *program_id,
                accounts: vec![
                    AccountMeta::new(*owner, true),
                    AccountMeta::new(pda, false),
                    AccountMeta::new_readonly(system_program::id(), false),
                ],
                data,
            },
            pda,
        )
    }

    fn close_ix(program_id: &Pubkey, owner: &Pubkey, pda: &Pubkey) -> Instruction {
        Instruction {
            program_id: *program_id,
            accounts: vec![
                AccountMeta::new(*owner, true),
                AccountMeta::new(*pda, false),
            ],
            data: vec![0x01u8],
        }
    }

    fn cleanup_ix(program_id: &Pubkey, keeper: &Pubkey, pda: &Pubkey) -> Instruction {
        Instruction {
            program_id: *program_id,
            accounts: vec![
                AccountMeta::new(*keeper, true),
                AccountMeta::new(*pda, false),
            ],
            data: vec![0x02u8],
        }
    }

    async fn set_clock(ctx: &mut ProgramTestContext, slot: u64) {
        let clock = Clock {
            slot,
            ..Default::default()
        };
        ctx.set_sysvar(&clock);
    }

    #[tokio::test]
    async fn test_create_scratch_ok() {
        let id = Pubkey::new_unique();
        let mut ctx = make_pt(id).start_with_context().await;
        set_clock(&mut ctx, 0).await;

        let owner = ctx.payer.insecure_clone();
        let tag = [0x01u8; 8];
        let bh = ctx.banks_client.get_latest_blockhash().await.unwrap();

        let (ix, pda) = create_ix(&id, &owner.pubkey(), 1000, tag);
        let tx = Transaction::new_signed_with_payer(&[ix], Some(&owner.pubkey()), &[&owner], bh);
        ctx.banks_client.process_transaction(tx).await.unwrap();

        let acc = ctx.banks_client.get_account(pda).await.unwrap().unwrap();
        assert_eq!(acc.owner, id);

        // Verify stored owner matches
        use dark_scratch::state::ScratchAccount;
        let state = ScratchAccount::unpack(&acc.data).unwrap();
        assert_eq!(state.owner, owner.pubkey().to_bytes());
    }

    #[tokio::test]
    async fn test_close_scratch_by_owner() {
        let id = Pubkey::new_unique();
        let mut ctx = make_pt(id).start_with_context().await;
        set_clock(&mut ctx, 0).await;

        let owner = ctx.payer.insecure_clone();
        let tag = [0x02u8; 8];

        let bh = ctx.banks_client.get_latest_blockhash().await.unwrap();
        let (create, pda) = create_ix(&id, &owner.pubkey(), 1000, tag);
        let tx =
            Transaction::new_signed_with_payer(&[create], Some(&owner.pubkey()), &[&owner], bh);
        ctx.banks_client.process_transaction(tx).await.unwrap();

        let bh2 = ctx.banks_client.get_latest_blockhash().await.unwrap();
        let close = close_ix(&id, &owner.pubkey(), &pda);
        let tx2 =
            Transaction::new_signed_with_payer(&[close], Some(&owner.pubkey()), &[&owner], bh2);
        ctx.banks_client.process_transaction(tx2).await.unwrap();

        let gone = ctx.banks_client.get_account(pda).await.unwrap();
        assert!(
            gone.is_none() || gone.unwrap().lamports == 0,
            "scratch PDA must be closed"
        );
    }

    #[tokio::test]
    async fn test_close_scratch_wrong_owner_fails() {
        let id = Pubkey::new_unique();
        let mut ctx = make_pt(id).start_with_context().await;
        set_clock(&mut ctx, 0).await;

        let owner = ctx.payer.insecure_clone();
        let tag = [0x03u8; 8];

        let bh = ctx.banks_client.get_latest_blockhash().await.unwrap();
        let (create, pda) = create_ix(&id, &owner.pubkey(), 1000, tag);
        let tx =
            Transaction::new_signed_with_payer(&[create], Some(&owner.pubkey()), &[&owner], bh);
        ctx.banks_client.process_transaction(tx).await.unwrap();

        // Create a different signer — use a fresh keypair funded separately
        use solana_sdk::signature::Keypair;
        let intruder = Keypair::new();

        // Fund intruder so they can pay fees
        let bh_fund = ctx.banks_client.get_latest_blockhash().await.unwrap();
        let fund_ix = solana_program::system_instruction::transfer(
            &owner.pubkey(),
            &intruder.pubkey(),
            1_000_000_000,
        );
        let fund_tx = Transaction::new_signed_with_payer(
            &[fund_ix],
            Some(&owner.pubkey()),
            &[&owner],
            bh_fund,
        );
        ctx.banks_client.process_transaction(fund_tx).await.unwrap();

        // Now intruder attempts to close the scratch pda owned by `owner`
        // The close_ix uses intruder as the "owner" account — but the PDA's stored owner is
        // the real owner, so the program will reject it.
        let bh2 = ctx.banks_client.get_latest_blockhash().await.unwrap();
        let bad_close = Instruction {
            program_id: id,
            accounts: vec![
                AccountMeta::new(intruder.pubkey(), true),
                AccountMeta::new(pda, false),
            ],
            data: vec![0x01u8],
        };
        let tx2 = Transaction::new_signed_with_payer(
            &[bad_close],
            Some(&intruder.pubkey()),
            &[&intruder],
            bh2,
        );
        assert!(
            ctx.banks_client.process_transaction(tx2).await.is_err(),
            "wrong owner must be rejected"
        );
    }

    #[tokio::test]
    async fn test_cleanup_before_expiry_fails() {
        let id = Pubkey::new_unique();
        let mut ctx = make_pt(id).start_with_context().await;
        // Set current slot to 3 (before expiry at 5)
        set_clock(&mut ctx, 3).await;

        let owner = ctx.payer.insecure_clone();
        let tag = [0x04u8; 8];

        let bh = ctx.banks_client.get_latest_blockhash().await.unwrap();
        // expires_at_slot = 5
        let (create, pda) = create_ix(&id, &owner.pubkey(), 5, tag);
        let tx =
            Transaction::new_signed_with_payer(&[create], Some(&owner.pubkey()), &[&owner], bh);
        ctx.banks_client.process_transaction(tx).await.unwrap();

        // Attempt cleanup at slot 3 (<=5) — must fail
        let bh2 = ctx.banks_client.get_latest_blockhash().await.unwrap();
        let cleanup = cleanup_ix(&id, &owner.pubkey(), &pda);
        let tx2 =
            Transaction::new_signed_with_payer(&[cleanup], Some(&owner.pubkey()), &[&owner], bh2);
        assert!(
            ctx.banks_client.process_transaction(tx2).await.is_err(),
            "cleanup before expiry must fail"
        );
    }
}

// ── Pure-logic unit tests (all platforms) ─────────────────────────────────────

#[test]
fn test_state_pack_unpack_roundtrip() {
    use dark_scratch::state::{ScratchAccount, SCRATCH_LEN, SCRATCH_VERSION};
    let original = ScratchAccount {
        version: SCRATCH_VERSION,
        bump: 254,
        owner: [0x42u8; 32],
        expires_at_slot: 99_999,
        tag: [0xDE, 0xAD, 0xBE, 0xEF, 0x00, 0x11, 0x22, 0x33],
        created_at_slot: 1_000,
    };
    let mut buf = vec![0u8; SCRATCH_LEN];
    original.pack_into(&mut buf);
    let unpacked = ScratchAccount::unpack(&buf).unwrap();

    assert_eq!(unpacked.version, original.version);
    assert_eq!(unpacked.bump, original.bump);
    assert_eq!(unpacked.owner, original.owner);
    assert_eq!(unpacked.expires_at_slot, original.expires_at_slot);
    assert_eq!(unpacked.tag, original.tag);
    assert_eq!(unpacked.created_at_slot, original.created_at_slot);
}

#[test]
fn test_state_wrong_version_rejected() {
    use dark_scratch::state::{ScratchAccount, SCRATCH_LEN};
    let mut buf = vec![0u8; SCRATCH_LEN];
    buf[0] = 0xFF; // invalid version
    assert!(ScratchAccount::unpack(&buf).is_none());
}

#[test]
fn test_instruction_encoding_create() {
    use dark_scratch::instruction::ScratchInstruction;
    let slot: u64 = 42_000;
    let tag = [0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF, 0x00, 0x11];
    let mut data = vec![0x00u8];
    data.extend_from_slice(&slot.to_le_bytes());
    data.extend_from_slice(&tag);
    let ix = ScratchInstruction::unpack(&data).unwrap();
    match ix {
        ScratchInstruction::CreateScratch {
            expires_at_slot,
            tag: t,
        } => {
            assert_eq!(expires_at_slot, slot);
            assert_eq!(t, tag);
        }
        _ => panic!("wrong variant"),
    }
}

#[test]
fn test_instruction_encoding_close() {
    use dark_scratch::instruction::ScratchInstruction;
    let ix = ScratchInstruction::unpack(&[0x01u8]).unwrap();
    assert!(matches!(ix, ScratchInstruction::CloseScratch));
}

#[test]
fn test_instruction_encoding_cleanup() {
    use dark_scratch::instruction::ScratchInstruction;
    let ix = ScratchInstruction::unpack(&[0x02u8]).unwrap();
    assert!(matches!(ix, ScratchInstruction::CleanupExpired));
}

#[test]
fn test_instruction_truncated_create_rejected() {
    use dark_scratch::instruction::ScratchInstruction;
    // Needs 17 bytes; provide 10
    let data = vec![0x00u8, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    assert!(ScratchInstruction::unpack(&data).is_err());
}

#[test]
fn test_instruction_unknown_tag_rejected() {
    use dark_scratch::instruction::ScratchInstruction;
    assert!(ScratchInstruction::unpack(&[0xFFu8]).is_err());
}

#[test]
fn test_scratch_len_matches_layout() {
    use dark_scratch::state::SCRATCH_LEN;
    // version(1) + bump(1) + owner(32) + expires_at_slot(8) + tag(8) + created_at_slot(8) = 58
    assert_eq!(SCRATCH_LEN, 58);
}

#[test]
fn test_instruction_empty_rejected() {
    use dark_scratch::instruction::ScratchInstruction;
    assert!(ScratchInstruction::unpack(&[]).is_err());
}

#[test]
fn test_state_unpack_short_slice_rejected() {
    use dark_scratch::state::ScratchAccount;
    assert!(ScratchAccount::unpack(&[1u8; 57]).is_none());
}

#[test]
fn test_scratch_seed_is_stable() {
    assert_eq!(dark_scratch::SCRATCH_SEED, b"scratch");
}

#[test]
fn test_create_instruction_preserves_full_tag() {
    use dark_scratch::instruction::ScratchInstruction;
    let tag = [1, 2, 3, 4, 5, 6, 7, 8];
    let mut data = vec![0x00u8];
    data.extend_from_slice(&9u64.to_le_bytes());
    data.extend_from_slice(&tag);
    let ScratchInstruction::CreateScratch { tag: parsed, .. } =
        ScratchInstruction::unpack(&data).unwrap()
    else {
        panic!("wrong instruction variant");
    };
    assert_eq!(parsed, tag);
}
