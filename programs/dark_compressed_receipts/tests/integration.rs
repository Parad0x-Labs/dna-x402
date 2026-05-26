// Programs using invoke_signed trigger the rbpf 0.8.3 pointer-overflow bug on
// Windows (STATUS_STACK_BUFFER_OVERRUN in solBankForksCli). These tests are
// correct and pass on Linux/macOS. The pure logic tests at the bottom run on
// all platforms.
use dark_compressed_receipts::{NULL_SEED, ROOT_SEED};

// ── Platform-gated ProgramTest integration tests ──────────────────────────────
#[cfg(not(target_os = "windows"))]
mod program_tests {
    use dark_compressed_receipts::{processor::process, NULL_SEED, ROOT_SEED};
    use solana_program::{
        instruction::{AccountMeta, Instruction},
        pubkey::Pubkey,
        system_program,
    };
    use solana_program_test::{processor, ProgramTest};
    use solana_sdk::{signature::Signer, transaction::Transaction};

    fn make_pt(id: Pubkey) -> ProgramTest {
        ProgramTest::new("dark_compressed_receipts", id, processor!(process))
    }

    fn root_pda(program_id: &Pubkey, authority: &Pubkey) -> (Pubkey, u8) {
        Pubkey::find_program_address(&[ROOT_SEED, authority.as_ref()], program_id)
    }

    fn null_pda(program_id: &Pubkey, nullifier: &[u8; 32]) -> (Pubkey, u8) {
        Pubkey::find_program_address(&[NULL_SEED, nullifier.as_ref()], program_id)
    }

    fn init_root_ix(program_id: &Pubkey, authority: &Pubkey) -> (Instruction, Pubkey) {
        let (pda, _) = root_pda(program_id, authority);
        (
            Instruction {
                program_id: *program_id,
                accounts: vec![
                    AccountMeta::new(*authority, true),
                    AccountMeta::new(pda, false),
                    AccountMeta::new_readonly(system_program::id(), false),
                ],
                data: vec![0x00],
            },
            pda,
        )
    }

    fn update_root_ix(
        program_id: &Pubkey,
        authority: &Pubkey,
        root: [u8; 32],
    ) -> (Instruction, Pubkey) {
        let (pda, _) = root_pda(program_id, authority);
        let mut data = vec![0x01];
        data.extend_from_slice(&root);
        (
            Instruction {
                program_id: *program_id,
                accounts: vec![
                    AccountMeta::new_readonly(*authority, true),
                    AccountMeta::new(pda, false),
                ],
                data,
            },
            pda,
        )
    }

    fn redeem_ix(
        program_id: &Pubkey,
        payer: &Pubkey,
        root: &Pubkey,
        nullifier: &[u8; 32],
    ) -> (Instruction, Pubkey) {
        let (npda, _) = null_pda(program_id, nullifier);
        let mut data = vec![0x02];
        data.extend_from_slice(nullifier);
        (
            Instruction {
                program_id: *program_id,
                accounts: vec![
                    AccountMeta::new(*payer, true),
                    AccountMeta::new_readonly(*root, false),
                    AccountMeta::new(npda, false),
                    AccountMeta::new_readonly(system_program::id(), false),
                ],
                data,
            },
            npda,
        )
    }

    #[tokio::test]
    async fn test_init_root_succeeds() {
        let id = Pubkey::new_unique();
        let mut ctx = make_pt(id).start_with_context().await;
        let payer = ctx.payer.insecure_clone();
        let bh = ctx.banks_client.get_latest_blockhash().await.unwrap();

        let (ix, pda) = init_root_ix(&id, &payer.pubkey());
        let tx = Transaction::new_signed_with_payer(&[ix], Some(&payer.pubkey()), &[&payer], bh);
        ctx.banks_client.process_transaction(tx).await.unwrap();

        let acc = ctx.banks_client.get_account(pda).await.unwrap().unwrap();
        assert_eq!(acc.owner, id);
    }

    #[tokio::test]
    async fn test_update_root_succeeds() {
        let id = Pubkey::new_unique();
        let mut ctx = make_pt(id).start_with_context().await;
        let payer = ctx.payer.insecure_clone();

        let (init_ix, root_addr) = init_root_ix(&id, &payer.pubkey());
        let new_root = [0xABu8; 32];
        let (upd_ix, _) = update_root_ix(&id, &payer.pubkey(), new_root);

        let bh = ctx.banks_client.get_latest_blockhash().await.unwrap();
        let tx = Transaction::new_signed_with_payer(
            &[init_ix, upd_ix],
            Some(&payer.pubkey()),
            &[&payer],
            bh,
        );
        ctx.banks_client.process_transaction(tx).await.unwrap();

        let acc = ctx
            .banks_client
            .get_account(root_addr)
            .await
            .unwrap()
            .unwrap();
        use dark_compressed_receipts::state::ReceiptRoot;
        use solana_program::program_pack::Pack;
        let state = ReceiptRoot::unpack_from_slice(&acc.data).unwrap();
        assert_eq!(state.root, new_root);
        assert_eq!(state.count, 1);
    }

    #[tokio::test]
    async fn test_redeem_once_succeeds() {
        let id = Pubkey::new_unique();
        let mut ctx = make_pt(id).start_with_context().await;
        let payer = ctx.payer.insecure_clone();

        let nullifier = [0x42u8; 32];
        let (init_ix, root_addr) = init_root_ix(&id, &payer.pubkey());
        let (red_ix, npda) = redeem_ix(&id, &payer.pubkey(), &root_addr, &nullifier);

        let bh = ctx.banks_client.get_latest_blockhash().await.unwrap();
        let tx = Transaction::new_signed_with_payer(
            &[init_ix, red_ix],
            Some(&payer.pubkey()),
            &[&payer],
            bh,
        );
        ctx.banks_client.process_transaction(tx).await.unwrap();

        let rec = ctx.banks_client.get_account(npda).await.unwrap().unwrap();
        assert_eq!(rec.owner, id, "nullifier record must be owned by program");
    }

    #[tokio::test]
    async fn test_double_redeem_fails() {
        let id = Pubkey::new_unique();
        let mut ctx = make_pt(id).start_with_context().await;
        let payer = ctx.payer.insecure_clone();

        let nullifier = [0x55u8; 32];
        let (init_ix, root_addr) = init_root_ix(&id, &payer.pubkey());
        let (red1, _) = redeem_ix(&id, &payer.pubkey(), &root_addr, &nullifier);

        let bh = ctx.banks_client.get_latest_blockhash().await.unwrap();
        let tx1 = Transaction::new_signed_with_payer(
            &[init_ix, red1],
            Some(&payer.pubkey()),
            &[&payer],
            bh,
        );
        ctx.banks_client.process_transaction(tx1).await.unwrap();

        let bh2 = ctx.banks_client.get_latest_blockhash().await.unwrap();
        let (red2, _) = redeem_ix(&id, &payer.pubkey(), &root_addr, &nullifier);
        let tx2 =
            Transaction::new_signed_with_payer(&[red2], Some(&payer.pubkey()), &[&payer], bh2);
        let result = ctx.banks_client.process_transaction(tx2).await;
        assert!(result.is_err(), "second redeem must fail");
    }

    #[tokio::test]
    async fn test_nullifier_pda_absent_before_redeem() {
        let id = Pubkey::new_unique();
        let mut ctx = make_pt(id).start_with_context().await;
        let payer = ctx.payer.insecure_clone();

        let (init_ix, _) = init_root_ix(&id, &payer.pubkey());
        let bh = ctx.banks_client.get_latest_blockhash().await.unwrap();
        let tx =
            Transaction::new_signed_with_payer(&[init_ix], Some(&payer.pubkey()), &[&payer], bh);
        ctx.banks_client.process_transaction(tx).await.unwrap();

        let nullifier = [0x99u8; 32];
        let (npda, _) = null_pda(&id, &nullifier);
        let rec = ctx.banks_client.get_account(npda).await.unwrap();
        assert!(
            rec.is_none(),
            "nullifier PDA must not exist before redemption"
        );
    }
}

// ── Pure-logic unit tests (all platforms) ─────────────────────────────────────

#[test]
fn test_state_pack_unpack_roundtrip() {
    use dark_compressed_receipts::state::{ReceiptRoot, RECEIPT_ROOT_LEN, ROOT_VERSION};
    use solana_program::program_pack::Pack;

    let original = ReceiptRoot {
        version: ROOT_VERSION,
        bump: 255,
        authority: [0x11u8; 32],
        root: [0xAAu8; 32],
        count: 42,
        updated_at: 1_700_000_000,
    };
    let mut buf = vec![0u8; RECEIPT_ROOT_LEN];
    original.pack_into_slice(&mut buf);
    let unpacked = ReceiptRoot::unpack_from_slice(&buf).unwrap();

    assert_eq!(unpacked.version, original.version);
    assert_eq!(unpacked.bump, original.bump);
    assert_eq!(unpacked.authority, original.authority);
    assert_eq!(unpacked.root, original.root);
    assert_eq!(unpacked.count, original.count);
    assert_eq!(unpacked.updated_at, original.updated_at);
}

#[test]
fn test_state_unpack_wrong_version_rejected() {
    use dark_compressed_receipts::state::{ReceiptRoot, RECEIPT_ROOT_LEN};
    use solana_program::program_pack::Pack;

    let mut buf = vec![0u8; RECEIPT_ROOT_LEN];
    buf[0] = 0xFF; // invalid version
    assert!(ReceiptRoot::unpack_from_slice(&buf).is_err());
}

#[test]
fn test_state_unpack_short_slice_rejected() {
    use dark_compressed_receipts::state::ReceiptRoot;
    use solana_program::program_pack::Pack;

    assert!(ReceiptRoot::unpack_from_slice(&[]).is_err());
    assert!(ReceiptRoot::unpack_from_slice(&[0u8; 10]).is_err());
}

#[test]
fn test_instruction_encoding_init_root() {
    use dark_compressed_receipts::instruction::ReceiptInstruction;
    let data = vec![0x00u8];
    let ix = ReceiptInstruction::unpack(&data).unwrap();
    assert!(matches!(ix, ReceiptInstruction::InitRoot));
}

#[test]
fn test_instruction_encoding_update_root() {
    use dark_compressed_receipts::instruction::ReceiptInstruction;
    let root = [0xBEu8; 32];
    let mut data = vec![0x01u8];
    data.extend_from_slice(&root);
    let ix = ReceiptInstruction::unpack(&data).unwrap();
    match ix {
        ReceiptInstruction::UpdateRoot { root: r } => assert_eq!(r, root),
        _ => panic!("wrong instruction variant"),
    }
}

#[test]
fn test_instruction_encoding_redeem_receipt() {
    use dark_compressed_receipts::instruction::ReceiptInstruction;
    let nullifier = [0xEFu8; 32];
    let mut data = vec![0x02u8];
    data.extend_from_slice(&nullifier);
    let ix = ReceiptInstruction::unpack(&data).unwrap();
    match ix {
        ReceiptInstruction::RedeemReceipt { nullifier: n } => assert_eq!(n, nullifier),
        _ => panic!("wrong instruction variant"),
    }
}

#[test]
fn test_instruction_unknown_tag_rejected() {
    use dark_compressed_receipts::instruction::ReceiptInstruction;
    assert!(ReceiptInstruction::unpack(&[0xFFu8]).is_err());
}

#[test]
fn test_instruction_truncated_update_root_rejected() {
    use dark_compressed_receipts::instruction::ReceiptInstruction;
    // 0x01 needs 33 bytes total; provide only 1
    assert!(ReceiptInstruction::unpack(&[0x01u8]).is_err());
}

#[test]
fn test_instruction_truncated_redeem_rejected() {
    use dark_compressed_receipts::instruction::ReceiptInstruction;
    // 0x02 needs 33 bytes total; provide only 10
    let mut short = vec![0x02u8];
    short.extend_from_slice(&[0u8; 9]);
    assert!(ReceiptInstruction::unpack(&short).is_err());
}

#[test]
fn test_receipt_root_len_matches_layout() {
    use dark_compressed_receipts::state::RECEIPT_ROOT_LEN;
    // version(1) + bump(1) + authority(32) + root(32) + count(4) + updated_at(8) = 78
    assert_eq!(RECEIPT_ROOT_LEN, 78);
}

#[test]
fn test_null_seed_and_root_seed_differ() {
    assert_ne!(NULL_SEED, ROOT_SEED);
}
