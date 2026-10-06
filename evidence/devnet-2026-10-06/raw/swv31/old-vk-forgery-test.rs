// Differential record, NOT part of the crate's tests: run against the tree BEFORE the
// v3.1 key (dna-x402 9f5f92a, VK sha256 d1cb06d3...), with --features devnet, by copying
// it to programs/dark_shielded_pool/tests/. It shows that the earlier key accepts the
// forged proof (built without a witness from the public beacon) and that the program
// pays out on it. The fixtures are the ones in tests/withdraw_vk_v3_1.rs.
//
// The earlier key's phase 2 was a public drand beacon applied to the deterministic
// `groth16 setup` key, so its delta was computable from public data and proofs could
// be forged without a witness (ceremony/shielded_withdraw_v3/ERRATA_v3.md). The
// fixtures below were made offline for a fixed program id, pool authority, recipient
// and relayer:
//   NEW_*    proofs from the v3.1 zkey (shielded_withdraw_v3_final.zkey)
//   OLD_0    proof from the earlier zkey (shielded_withdraw_v3_beacon_only_final.zkey)
//   FORGED_0 proof built from the earlier key's public delta by
//            ceremony/check-beacon-delta.mjs (no witness); snarkjs accepts it
//            against shielded_withdraw_v3_beacon_only_vk.json
// All four use the same root, recipient, pool, relayer, fee and denomination.
//
// Runs natively and, with SBF_OUT_DIR set, against the built .so. The accept path
// needs the `devnet` feature (the mainnet build refuses every proof while the VK has
// mainnet_ready = false); without it the guard test runs instead.
#![cfg(not(target_os = "windows"))]

use dark_shielded_pool_program::{
    instruction::PoolInstruction,
    processor::{verify_proof_groth16, NOTE_LEAF_SEED, NULLIFIER_SEED, POOL_CONFIG_SEED, POOL_VAULT_SEED},
};
use solana_program::{pubkey::Pubkey, system_program};
use solana_program_test::*;
use solana_sdk::{
    instruction::{AccountMeta, Instruction, InstructionError},
    signature::{Keypair, Signer},
    signer::keypair::keypair_from_seed,
    system_instruction,
    transaction::{Transaction, TransactionError},
};

const DENOM: u64 = 100_000_000;
const FEE: u64 = 1_000_000;

const COMMITMENT_0: &str = "1404711f4ecfbe21b2fcbbbf90bd834c83a036ecd2abb90d04ef3fd234a673e1";
const COMMITMENT_1: &str = "10e75f3210f81bfb0210afd73ca6c07ae897a8a68cc9d88a435d0615b23419ca";
const ROOT: &str = "1d349d69e9e9c76657e22433fa1233b0ba50558affd86ac586c71d092634f04e";
const NULLIFIER_0: &str = "0bb7eea8460d5eb3685d548b14f08ba0ab2054d89bef860d619b7eb61faa5b01";
const NULLIFIER_1: &str = "0d7e0e141f24a3698e04c3f76b917ea8a5a0e23f15257e90c451d4887b4d407c";
const NEW_1_PROOF: &str = concat!(
    "0dba376927b45ff4337f2dcca6fd8c1b64e3e2df1a2bfaf2aeefe78e299edbe003103a3aff515b1c791dd04a1016515c94132199be85eac9040bea4f6c931f69",
    "2ed0d48c5a33ec243cf422e74b87536cd1c08242d48576e656a4b9e8d5d77ce00b7bbbd990d309857b6d46ea7cae88c0e0536a6dc25a29a44cd3b334fee2bac3",
    "0bdeb5ff656e524e04b65c83000de70dfe343ce7f4c3b71dcca54a2bab58978a20dd3b0ffa9f95a42422716a96ccf48c889a09310c1194b4ff0fbfc8ab6ce49d",
    "183127ba7c406cf19822901c91c2f35931ebdc229a142eb6cdcf27a09dbb3eae291c7f37c0f4b217ba407eb66626243a34218a30d3df7b5bade2c8fe05d1714c",
);
const NEW_0_PROOF: &str = concat!(
    "079c87663e2f07440c14966faa233b659d7fc22d27c5d8aae3caa56d236ad77e25e417aeac1d5d53aa332a2913aa8a686ae820deca4a3f81b62682dea1206818",
    "10f3ab50a14162505a0e1dae4c4bff5f0a008f0a06b616e2518261bfacd3265220ca33b767d74da6d6d6aa8580798a2bfad82d33828b26b044569dd074c54c42",
    "1685ed1530fabf8e03740fe366aef41e2b13695e893f8a57411b4bf41e75561b282289afcac0138e8325edb11ad3705c1bacd7420df0f75bb6ec80f18fd3f78e",
    "256f1768c9ae744a3e3c2469dd87aebaafec18ef019702c1bd38b8b5fd6669520c4a6b21bef9cc2a9fcc222c435e76147dd0fc88ead5c9d1a81c2b63f5d83fbb",
);
const OLD_0_PROOF: &str = concat!(
    "0ad425e96db0c41417bd4e59ca5c8425306c6f28aa52f27db62e32e73332d9a215ed52bf966001454d1c0472dc336966c43cca577c70d158b15c55853682ce2f",
    "25a1baa3f3e7d508ac613a7d7223b032e4fcc2122a8698463477b347365fae072667669c09560fe7329ebd1c966a765156ac495b2734c37c5ee93b1531e6d040",
    "26fb5b5ae2066abf128c900c965a8ed044ada708bf5a3c6ec93ee5211edf8d9e1fafec0a88e3974539206b34adfb1138f909038bde1c68ac5bf67f9d6787b11c",
    "1483349decef9934b3b46723090c7b9ff59f9d8c2456998475395f7623a28bd62ae732b745343eeb41065e6509656d12c5ade56706d547e3e4c41c62253562c5",
);
const FORGED_0_PROOF: &str = concat!(
    "2d4d9aa7e302d9df41749d5507949d05dbea33fbb16c643b22f599a2be6df2e214bedd503c37ceb061d8ec60209fe345ce89830a19230301f076caff004d1926",
    "0967032fcbf776d1afc985f88877f182d38480a653f2decaa9794cbc3bf3060c0e187847ad4c798374d0d6732bf501847dd68bc0e071241e0213bc7fc13db7ab",
    "304cfbd1e08a704a99f5e847d93f8c3caafddec46b7a0d379da69a4d112346a71739c1b1a457a8c7313123d24d2f9192f896b7c63eea05a9d57f06547ad0cec8",
    "04b790b790c09dbb38dffb9a9050a2f4b3935a56d17b9593a143ef9fb4c687b624615f6f7a483207bec38f5a4c768567bd499e6fb74635dbad4b9ec25e70b41e",
);

// ShieldedPoolError codes
const PROOF_INVALID: u32 = 4;

fn hex<const N: usize>(s: &str) -> [u8; N] {
    assert_eq!(s.len(), N * 2, "hex length");
    let mut out = [0u8; N];
    for (i, b) in out.iter_mut().enumerate() {
        *b = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).expect("hex digit");
    }
    out
}

struct Fixture {
    program_id: Pubkey,
    authority: Keypair,
    recipient: Pubkey,
    relayer: Keypair,
    config: Pubkey,
    vault: Pubkey,
}

fn fixture() -> Fixture {
    let program_id = Pubkey::new_from_array([7u8; 32]);
    let authority = keypair_from_seed(&[11u8; 32]).unwrap();
    let recipient = keypair_from_seed(&[12u8; 32]).unwrap().pubkey();
    let relayer = keypair_from_seed(&[13u8; 32]).unwrap();
    let config = Pubkey::find_program_address(&[POOL_CONFIG_SEED, authority.pubkey().as_ref()], &program_id).0;
    let vault = Pubkey::find_program_address(&[POOL_VAULT_SEED, config.as_ref()], &program_id).0;
    Fixture { program_id, authority, recipient, relayer, config, vault }
}

fn verify(f: &Fixture, proof: &str, nullifier: &str) -> bool {
    verify_proof_groth16(
        &hex::<256>(proof),
        &hex::<32>(nullifier),
        &hex::<32>(ROOT),
        &f.recipient.to_bytes(),
        &f.config.to_bytes(),
        &f.relayer.pubkey().to_bytes(),
        FEE,
        DENOM,
    )
}

fn ix(f: &Fixture, accounts: Vec<AccountMeta>, data: PoolInstruction) -> Instruction {
    Instruction { program_id: f.program_id, accounts, data: data.pack() }
}

fn withdraw_ix(f: &Fixture, proof: &str, nullifier: &str) -> Instruction {
    let null = hex::<32>(nullifier);
    let rec = Pubkey::find_program_address(&[NULLIFIER_SEED, f.config.as_ref(), &null], &f.program_id).0;
    ix(
        f,
        vec![
            AccountMeta::new(f.config, false),
            AccountMeta::new(f.vault, false),
            AccountMeta::new(rec, false),
            AccountMeta::new(f.recipient, false),
            AccountMeta::new(f.relayer.pubkey(), true),
            AccountMeta::new_readonly(system_program::id(), false),
        ],
        PoolInstruction::Withdraw {
            nullifier: null,
            root: hex::<32>(ROOT),
            proof: hex::<256>(proof),
            recipient: f.recipient,
            relayer: f.relayer.pubkey(),
            fee: FEE,
        },
    )
}

async fn send(ctx: &mut ProgramTestContext, ixs: &[Instruction], payer: &Keypair) -> Result<(), TransactionError> {
    let bh = ctx.banks_client.get_new_latest_blockhash(&ctx.last_blockhash).await.unwrap();
    ctx.last_blockhash = bh;
    let mut tx = Transaction::new_with_payer(ixs, Some(&payer.pubkey()));
    tx.sign(&[payer], bh);
    ctx.banks_client.process_transaction(tx).await.map_err(|e| e.unwrap())
}

fn custom(code: u32) -> TransactionError {
    TransactionError::InstructionError(0, InstructionError::Custom(code))
}

async fn balance(ctx: &mut ProgramTestContext, k: Pubkey) -> u64 {
    ctx.banks_client.get_balance(k).await.unwrap()
}

#[test]
fn earlier_vk_accepts_old_and_forged_proofs_and_rejects_v3_1() {
    let f = fixture();
    assert!(verify(&f, OLD_0_PROOF, NULLIFIER_0), "proof from the earlier zkey");
    assert!(verify(&f, FORGED_0_PROOF, NULLIFIER_0), "forged proof accepted by the earlier VK");
    assert!(!verify(&f, NEW_1_PROOF, NULLIFIER_1), "v3.1 proof does not verify under the earlier VK");
}

#[tokio::test]
async fn forged_proof_withdraws_under_the_earlier_vk() {
    let f = fixture();
    let mut pt = ProgramTest::new(
        "dark_shielded_pool_program",
        f.program_id,
        processor!(dark_shielded_pool_program::processor::process_instruction),
    );
    pt.set_compute_max_units(1_400_000);
    let mut ctx = pt.start_with_context().await;
    let payer = ctx.payer.insecure_clone();
    for k in [f.authority.pubkey(), f.relayer.pubkey()] {
        send(&mut ctx, &[system_instruction::transfer(&payer.pubkey(), &k, 1_000_000_000)], &payer).await.unwrap();
    }
    let init = ix(
        &f,
        vec![
            AccountMeta::new(f.config, false),
            AccountMeta::new(f.vault, false),
            AccountMeta::new(f.authority.pubkey(), true),
            AccountMeta::new_readonly(system_program::id(), false),
        ],
        PoolInstruction::InitPool { denomination: DENOM },
    );
    send(&mut ctx, &[init], &f.authority).await.expect("init pool");
    for (i, c) in [COMMITMENT_0, COMMITMENT_1].iter().enumerate() {
        let leaf = Pubkey::find_program_address(&[NOTE_LEAF_SEED, f.config.as_ref(), &(i as u64).to_le_bytes()], &f.program_id).0;
        let dep = ix(
            &f,
            vec![
                AccountMeta::new(f.config, false),
                AccountMeta::new(f.vault, false),
                AccountMeta::new(leaf, false),
                AccountMeta::new(f.authority.pubkey(), true),
                AccountMeta::new_readonly(system_program::id(), false),
            ],
            PoolInstruction::Deposit { commitment: hex::<32>(c) },
        );
        send(&mut ctx, &[dep], &f.authority).await.expect("deposit");
    }
    let rec_before = balance(&mut ctx, f.recipient).await;
    send(&mut ctx, &[withdraw_ix(&f, FORGED_0_PROOF, NULLIFIER_0)], &f.relayer).await.expect("forged withdraw accepted");
    assert_eq!(balance(&mut ctx, f.recipient).await - rec_before, DENOM - FEE, "forged proof paid out");
    let err = send(&mut ctx, &[withdraw_ix(&f, NEW_1_PROOF, NULLIFIER_1)], &f.relayer).await.unwrap_err();
    assert_eq!(err, custom(PROOF_INVALID), "v3.1 proof refused by the earlier VK");
}
