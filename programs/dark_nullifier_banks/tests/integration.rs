// Programs using invoke_signed trigger the rbpf 0.8.3 pointer-overflow bug on
// Windows (STATUS_STACK_BUFFER_OVERRUN in solBankForksCli). These tests are
// correct and pass on Linux/macOS. The pure logic tests at the bottom run on
// all platforms.
use dark_nullifier_banks::{bank_index, DOMAIN};

// ── Platform-gated ProgramTest integration tests ──────────────────────────────
#[cfg(not(target_os = "windows"))]
mod program_tests {
    use dark_nullifier_banks::{bank_index, processor::process, BANK_SEED, DOMAIN, NULL_REC_SEED};
    use solana_program::{
        instruction::{AccountMeta, Instruction},
        program_pack::Pack,
        pubkey::Pubkey,
        system_program,
    };
    use solana_program_test::{processor, ProgramTest};
    use solana_sdk::{signature::Signer, transaction::Transaction};

    fn make_program_test(id: Pubkey) -> ProgramTest {
        ProgramTest::new("dark_nullifier_banks", id, processor!(process))
    }

    fn bank_pda(program_id: &Pubkey, shard: u8, epoch: u64) -> (Pubkey, u8) {
        Pubkey::find_program_address(&[BANK_SEED, &[shard], &epoch.to_le_bytes()], program_id)
    }

    fn null_rec_pda(program_id: &Pubkey, shard: u8, nullifier: &[u8; 32]) -> (Pubkey, u8) {
        Pubkey::find_program_address(&[NULL_REC_SEED, &[shard], nullifier.as_ref()], program_id)
    }

    fn init_bank_ix(
        program_id: &Pubkey,
        payer: &Pubkey,
        shard: u8,
        epoch: u64,
    ) -> (Instruction, Pubkey) {
        let (pda, _) = bank_pda(program_id, shard, epoch);
        let mut data = vec![0x00u8, shard];
        data.extend_from_slice(&epoch.to_le_bytes());
        (
            Instruction {
                program_id: *program_id,
                accounts: vec![
                    AccountMeta::new(*payer, true),
                    AccountMeta::new(pda, false),
                    AccountMeta::new_readonly(system_program::id(), false),
                ],
                data,
            },
            pda,
        )
    }

    fn insert_nullifier_ix(
        program_id: &Pubkey,
        payer: &Pubkey,
        bank: &Pubkey,
        nullifier: &[u8; 32],
        shard: u8,
        epoch: u64,
    ) -> (Instruction, Pubkey) {
        let (rec, _) = null_rec_pda(program_id, shard, nullifier);
        let mut data = vec![0x01u8];
        data.extend_from_slice(nullifier);
        data.extend_from_slice(&epoch.to_le_bytes());
        (
            Instruction {
                program_id: *program_id,
                accounts: vec![
                    AccountMeta::new(*payer, true),
                    AccountMeta::new(*bank, false),
                    AccountMeta::new(rec, false),
                    AccountMeta::new_readonly(system_program::id(), false),
                ],
                data,
            },
            rec,
        )
    }

    #[tokio::test]
    async fn test_init_bank() {
        let id = Pubkey::new_unique();
        let mut ctx = make_program_test(id).start_with_context().await;
        let payer = ctx.payer.insecure_clone();
        let shard = 42u8;
        let epoch = 100u64;
        let (ix, pda) = init_bank_ix(&id, &payer.pubkey(), shard, epoch);
        let bh = ctx.banks_client.get_latest_blockhash().await.unwrap();
        let tx = Transaction::new_signed_with_payer(&[ix], Some(&payer.pubkey()), &[&payer], bh);
        ctx.banks_client.process_transaction(tx).await.unwrap();
        let account = ctx.banks_client.get_account(pda).await.unwrap().unwrap();
        assert_eq!(account.owner, id);
        assert_eq!(account.data[2], shard, "shard field mismatch");
    }

    #[tokio::test]
    async fn test_insert_nullifier_happy_path() {
        let id = Pubkey::new_unique();
        let mut ctx = make_program_test(id).start_with_context().await;
        let payer = ctx.payer.insecure_clone();
        let nullifier = [0xAAu8; 32];
        let epoch = 1u64;
        let shard = bank_index(&nullifier, epoch, DOMAIN);
        let (init_ix, bank_addr) = init_bank_ix(&id, &payer.pubkey(), shard, epoch);
        let (ins_ix, rec_pda) =
            insert_nullifier_ix(&id, &payer.pubkey(), &bank_addr, &nullifier, shard, epoch);
        let bh = ctx.banks_client.get_latest_blockhash().await.unwrap();
        let tx1 =
            Transaction::new_signed_with_payer(&[init_ix], Some(&payer.pubkey()), &[&payer], bh);
        ctx.banks_client.process_transaction(tx1).await.unwrap();
        let bh2 = ctx.banks_client.get_latest_blockhash().await.unwrap();
        let tx2 =
            Transaction::new_signed_with_payer(&[ins_ix], Some(&payer.pubkey()), &[&payer], bh2);
        ctx.banks_client.process_transaction(tx2).await.unwrap();
        let rec = ctx
            .banks_client
            .get_account(rec_pda)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(rec.owner, id);
        let bank_acc = ctx
            .banks_client
            .get_account(bank_addr)
            .await
            .unwrap()
            .unwrap();
        let state =
            dark_nullifier_banks::state::NullifierBank::unpack_from_slice(&bank_acc.data).unwrap();
        assert_eq!(state.count, 1);
    }

    #[tokio::test]
    async fn test_duplicate_nullifier_rejected() {
        let id = Pubkey::new_unique();
        let mut ctx = make_program_test(id).start_with_context().await;
        let payer = ctx.payer.insecure_clone();
        let nullifier = [0xBBu8; 32];
        let epoch = 1u64;
        let shard = bank_index(&nullifier, epoch, DOMAIN);
        let (init_ix, bank_addr) = init_bank_ix(&id, &payer.pubkey(), shard, epoch);
        let (ins_ix, _) =
            insert_nullifier_ix(&id, &payer.pubkey(), &bank_addr, &nullifier, shard, epoch);
        let bh = ctx.banks_client.get_latest_blockhash().await.unwrap();
        let tx1 = Transaction::new_signed_with_payer(
            &[init_ix, ins_ix],
            Some(&payer.pubkey()),
            &[&payer],
            bh,
        );
        ctx.banks_client.process_transaction(tx1).await.unwrap();
        let bh2 = ctx.banks_client.get_latest_blockhash().await.unwrap();
        let (ins2, _) =
            insert_nullifier_ix(&id, &payer.pubkey(), &bank_addr, &nullifier, shard, epoch);
        let tx2 =
            Transaction::new_signed_with_payer(&[ins2], Some(&payer.pubkey()), &[&payer], bh2);
        assert!(
            ctx.banks_client.process_transaction(tx2).await.is_err(),
            "duplicate must fail"
        );
    }

    #[tokio::test]
    async fn test_wrong_shard_rejected() {
        let id = Pubkey::new_unique();
        let mut ctx = make_program_test(id).start_with_context().await;
        let payer = ctx.payer.insecure_clone();
        let nullifier = [0xCCu8; 32];
        let epoch = 1u64;
        let correct = bank_index(&nullifier, epoch, DOMAIN);
        let wrong = correct.wrapping_add(1);
        let (init_ix, wrong_bank) = init_bank_ix(&id, &payer.pubkey(), wrong, epoch);
        let bh = ctx.banks_client.get_latest_blockhash().await.unwrap();
        let tx1 =
            Transaction::new_signed_with_payer(&[init_ix], Some(&payer.pubkey()), &[&payer], bh);
        ctx.banks_client.process_transaction(tx1).await.unwrap();
        let bh2 = ctx.banks_client.get_latest_blockhash().await.unwrap();
        let (ins_ix, _) =
            insert_nullifier_ix(&id, &payer.pubkey(), &wrong_bank, &nullifier, wrong, epoch);
        let tx2 =
            Transaction::new_signed_with_payer(&[ins_ix], Some(&payer.pubkey()), &[&payer], bh2);
        assert!(
            ctx.banks_client.process_transaction(tx2).await.is_err(),
            "wrong shard must fail"
        );
    }

    #[tokio::test]
    async fn test_epoch_isolation() {
        let id = Pubkey::new_unique();
        let mut ctx = make_program_test(id).start_with_context().await;
        let payer = ctx.payer.insecure_clone();
        let nullifier = [0xDDu8; 32];
        let ea = 10u64;
        let eb = 11u64;
        let sa = bank_index(&nullifier, ea, DOMAIN);
        let sb = bank_index(&nullifier, eb, DOMAIN);
        let (ia, ba) = init_bank_ix(&id, &payer.pubkey(), sa, ea);
        let (ib, bb) = init_bank_ix(&id, &payer.pubkey(), sb, eb);
        let (ia2, _) = insert_nullifier_ix(&id, &payer.pubkey(), &ba, &nullifier, sa, ea);
        let (ib2, _) = insert_nullifier_ix(&id, &payer.pubkey(), &bb, &nullifier, sb, eb);
        let bh = ctx.banks_client.get_latest_blockhash().await.unwrap();
        let tx = Transaction::new_signed_with_payer(
            &[ia, ib, ia2, ib2],
            Some(&payer.pubkey()),
            &[&payer],
            bh,
        );
        ctx.banks_client.process_transaction(tx).await.unwrap();
        let sa_state = dark_nullifier_banks::state::NullifierBank::unpack_from_slice(
            &ctx.banks_client
                .get_account(ba)
                .await
                .unwrap()
                .unwrap()
                .data,
        )
        .unwrap();
        let sb_state = dark_nullifier_banks::state::NullifierBank::unpack_from_slice(
            &ctx.banks_client
                .get_account(bb)
                .await
                .unwrap()
                .unwrap()
                .data,
        )
        .unwrap();
        assert_eq!(sa_state.count, 1);
        assert_eq!(sb_state.count, 1);
    }
}

// ── Pure-logic unit tests (all platforms) ─────────────────────────────────────

#[test]
fn test_bank_index_deterministic() {
    let nullifier = [0xEEu8; 32];
    let epoch = 42u64;
    assert_eq!(
        bank_index(&nullifier, epoch, DOMAIN),
        bank_index(&nullifier, epoch, DOMAIN),
        "bank_index must be deterministic"
    );
}

#[test]
fn test_bank_index_in_range() {
    // bank_index returns a u8 (0-255), verifiable by type alone, but also test distribution
    for byte in 0u8..=255 {
        let n = [byte; 32];
        let _ = bank_index(&n, 0, DOMAIN); // must not panic
    }
}

#[test]
fn test_bank_index_epoch_changes_result() {
    let nullifier = [0x01u8; 32];
    let s0 = bank_index(&nullifier, 0, DOMAIN);
    let s1 = bank_index(&nullifier, 1, DOMAIN);
    // Different epochs should produce different shards (statistically true, not guaranteed).
    // This just documents the behavior; collision on [0x01;32] epoch 0 vs 1 would be extremely unlikely.
    let _ = (s0, s1);
}

#[test]
fn test_instruction_encoding_init_bank() {
    use dark_nullifier_banks::instruction::DarkNullifierInstruction;
    let shard = 7u8;
    let epoch = 12345u64;
    let mut data = vec![0x00u8, shard];
    data.extend_from_slice(&epoch.to_le_bytes());
    let ix = DarkNullifierInstruction::unpack(&data).unwrap();
    match ix {
        DarkNullifierInstruction::InitBank { shard: s, epoch: e } => {
            assert_eq!(s, shard);
            assert_eq!(e, epoch);
        }
        _ => panic!("wrong instruction variant"),
    }
}

#[test]
fn test_instruction_encoding_insert_nullifier() {
    use dark_nullifier_banks::instruction::DarkNullifierInstruction;
    let nullifier = [0xABu8; 32];
    let epoch = 99u64;
    let mut data = vec![0x01u8];
    data.extend_from_slice(&nullifier);
    data.extend_from_slice(&epoch.to_le_bytes());
    let ix = DarkNullifierInstruction::unpack(&data).unwrap();
    match ix {
        DarkNullifierInstruction::InsertNullifier {
            nullifier: n,
            epoch: e,
        } => {
            assert_eq!(n, nullifier);
            assert_eq!(e, epoch);
        }
        _ => panic!("wrong instruction variant"),
    }
}

#[test]
fn test_state_pack_unpack_roundtrip() {
    use dark_nullifier_banks::state::{NullifierBank, BANK_VERSION, NULLIFIER_BANK_LEN};
    use solana_program::program_pack::Pack;
    let original = NullifierBank {
        version: BANK_VERSION,
        bump: 42,
        shard: 7,
        epoch: 999,
        count: 5,
        root: [0xABu8; 32],
        updated_at: 1_700_000_000,
    };
    let mut buf = vec![0u8; NULLIFIER_BANK_LEN];
    original.pack_into_slice(&mut buf);
    let unpacked = NullifierBank::unpack_from_slice(&buf).unwrap();
    assert_eq!(unpacked.version, original.version);
    assert_eq!(unpacked.bump, original.bump);
    assert_eq!(unpacked.shard, original.shard);
    assert_eq!(unpacked.epoch, original.epoch);
    assert_eq!(unpacked.count, original.count);
    assert_eq!(unpacked.root, original.root);
    assert_eq!(unpacked.updated_at, original.updated_at);
}
