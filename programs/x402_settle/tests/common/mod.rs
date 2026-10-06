// Shared harness for the x402_settle integration tests.
//
// By default the native processor runs. Run against the SBF binary with
// `SBF_OUT_DIR=<dir with x402_settle.so> cargo test`; compute units are then
// the metered ones.
#![allow(dead_code)]

use solana_program_test::*;
use solana_sdk::{
    account::Account,
    clock::Clock,
    compute_budget::ComputeBudgetInstruction,
    hash::Hash,
    instruction::{Instruction, InstructionError},
    message::Message,
    pubkey::Pubkey,
    rent::Rent,
    signature::{Keypair, Signer},
    slot_hashes::SlotHashes,
    system_instruction, system_program,
    transaction::{Transaction, TransactionError},
};
use x402_settle::{
    crypto,
    error::XsError,
    instruction::{self as ix, SplAccounts, WireClose, WireVoucher},
    state::*,
    token,
};

pub const SOL: u64 = 1_000_000_000;
pub const V1_MAX_BYTES: usize = 4_096;
pub const V1_MAX_ACCOUNTS: usize = 64;

pub fn ce(e: XsError) -> InstructionError {
    InstructionError::Custom(e.code())
}

pub fn sbf() -> bool {
    std::env::var("SBF_OUT_DIR").is_ok() || std::env::var("BPF_OUT_DIR").is_ok()
}

/// Serialized size of a SIMD-0385 V1 transaction carrying `ixs` (compute
/// limit and loaded-data size in the config mask, no compute budget
/// instructions), plus its address and signature counts. Layout as in the
/// spike serializer: version, header, mask, blockhash, counts, addresses,
/// config values, instruction headers and bodies, then signatures.
pub fn v1_size(ixs: &[Instruction], payer: &Pubkey) -> (usize, usize, usize) {
    let msg = Message::new(ixs, Some(payer));
    let a = msg.account_keys.len();
    let s = msg.header.num_required_signatures as usize;
    let mut size = 1 + 3 + 4 + 32 + 1 + 1 + 32 * a + 8 + 64 * s;
    for ci in &msg.instructions {
        size += 4 + ci.accounts.len() + ci.data.len();
    }
    (size, a, s)
}

pub struct T {
    pub ctx: ProgramTestContext,
    pub pid: Pubkey,
    pub n: u32,
    pub slot: u64,
    pub rent: Rent,
    pub bank_slot: u64,
}

impl T {
    pub async fn new(funded: &[&Keypair]) -> Self {
        let pid = x402_settle::id();
        let mut pt = ProgramTest::new("x402_settle", pid, processor!(x402_settle::process_instruction));
        pt.set_compute_max_units(1_400_000);
        for k in funded {
            pt.add_account(k.pubkey(), Account::new(10_000 * SOL, 0, &system_program::id()));
        }
        let mut ctx = pt.start_with_context().await;
        let rent = ctx.banks_client.get_rent().await.unwrap();
        let mut t = T { ctx, pid, n: 0, slot: 0, rent, bank_slot: 1 };
        t.warp(1_000).await;
        let h = Hash::new_from_array([7u8; 32]);
        t.ctx.set_sysvar(&SlotHashes::new(&[(999, h)]));
        t
    }

    /// Moves to a new bank (fresh block limits and blockhash) and restores
    /// the test clock. Long sequences otherwise all land in one bank.
    pub async fn new_block(&mut self) {
        self.bank_slot += 1;
        self.ctx.warp_to_slot(self.bank_slot).unwrap();
        self.ctx.last_blockhash = self.ctx.get_new_latest_blockhash().await.unwrap();
        let s = self.slot;
        self.warp(s).await;
        let h = Hash::new_from_array([7u8; 32]);
        self.ctx.set_sysvar(&SlotHashes::new(&[(999, h)]));
    }

    pub async fn warp(&mut self, slot: u64) {
        let mut c: Clock = self.ctx.banks_client.get_sysvar().await.unwrap();
        c.slot = slot;
        self.ctx.set_sysvar(&c);
        self.slot = slot;
    }

    pub fn payer(&self) -> Keypair {
        self.ctx.payer.insecure_clone()
    }

    pub async fn send(&mut self, ixs: Vec<Instruction>, signers: &[&Keypair]) -> Result<(), InstructionError> {
        self.send_with_payer(ixs, signers, None).await
    }

    /// Sends with `fee_payer` (default: the context payer).
    pub async fn send_with_payer(
        &mut self,
        ixs: Vec<Instruction>,
        signers: &[&Keypair],
        fee_payer: Option<&Keypair>,
    ) -> Result<(), InstructionError> {
        self.n += 1;
        let mut all = vec![ComputeBudgetInstruction::set_compute_unit_limit(1_400_000 - self.n)];
        all.extend(ixs);
        let payer = fee_payer.map(|k| k.insecure_clone()).unwrap_or_else(|| self.payer());
        let mut s: Vec<&Keypair> = vec![&payer];
        for k in signers {
            if k.pubkey() != payer.pubkey() {
                s.push(k);
            }
        }
        let bh = self.ctx.last_blockhash;
        let tx = Transaction::new_signed_with_payer(&all, Some(&payer.pubkey()), &s, bh);
        match self.ctx.banks_client.process_transaction(tx).await {
            Ok(()) => Ok(()),
            Err(BanksClientError::TransactionError(TransactionError::InstructionError(_, e))) => Err(e),
            Err(BanksClientError::SimulationError { err: TransactionError::InstructionError(_, e), .. }) => Err(e),
            Err(e) => panic!("unexpected error: {e:?}"),
        }
    }

    /// Simulated compute units of a transaction holding only `ixs` (plus a
    /// 1.4M compute limit).
    pub async fn cu(&mut self, ixs: Vec<Instruction>, signers: &[&Keypair], fee_payer: Option<&Keypair>) -> u64 {
        match self.try_cu(ixs, signers, fee_payer).await {
            Ok(u) => u,
            Err(e) => panic!("simulation failed: {e}"),
        }
    }

    /// Like `cu`, but returns the failure instead of panicking.
    pub async fn try_cu(&mut self, ixs: Vec<Instruction>, signers: &[&Keypair], fee_payer: Option<&Keypair>) -> Result<u64, String> {
        let mut all = vec![ComputeBudgetInstruction::set_compute_unit_limit(1_400_000)];
        all.extend(ixs);
        let payer = fee_payer.map(|k| k.insecure_clone()).unwrap_or_else(|| self.payer());
        let mut s: Vec<&Keypair> = vec![&payer];
        for k in signers {
            if k.pubkey() != payer.pubkey() {
                s.push(k);
            }
        }
        let tx = Transaction::new_signed_with_payer(&all, Some(&payer.pubkey()), &s, self.ctx.last_blockhash);
        let r = self.ctx.banks_client.simulate_transaction(tx).await.unwrap();
        if let Some(Err(e)) = &r.result {
            return Err(format!("{e:?} {:?}", r.simulation_details.map(|d| d.logs)));
        }
        // minus the compute budget instruction (150 CU)
        Ok(r.simulation_details.unwrap().units_consumed - 150)
    }

    pub async fn account(&mut self, k: &Pubkey) -> Option<Account> {
        self.ctx.banks_client.get_account(*k).await.unwrap()
    }

    pub async fn data(&mut self, k: &Pubkey) -> Vec<u8> {
        self.account(k).await.expect("account").data
    }

    pub async fn lamports(&mut self, k: &Pubkey) -> u64 {
        self.account(k).await.map(|a| a.lamports).unwrap_or(0)
    }

    pub async fn fund(&mut self, to: &Pubkey, lamports: u64) {
        let p = self.payer();
        self.send(vec![system_instruction::transfer(&p.pubkey(), to, lamports)], &[]).await.unwrap();
    }
}

// ---------------------------------------------------------------------------
// Ledger fixture
// ---------------------------------------------------------------------------

#[derive(Clone, Copy)]
pub struct L {
    pub pid: Pubkey,
    pub ledger: Pubkey,
    pub mint: Pubkey,
    pub mint_b: [u8; 32],
    pub salt: [u8; 32],
    pub kind: u8,
    pub spl: Option<SplAccounts>,
}

impl L {
    pub fn escrow(&self, payer: &Pubkey) -> Pubkey {
        ix::escrow_pda(&self.pid, &self.ledger, payer).0
    }
    pub fn book(&self, page: u32) -> Pubkey {
        ix::book_pda(&self.pid, &self.ledger, page).0
    }
    pub fn channel(&self, payer: &Pubkey, payee: &Pubkey, id: u64) -> Pubkey {
        ix::channel_pda(&self.pid, &self.ledger, payer, payee, id).0
    }
    pub fn batch(&self, id: u64) -> Pubkey {
        ix::batch_pda(&self.pid, &self.ledger, id).0
    }
    pub fn msg(&self, payer: &Pubkey, payee: &Pubkey, scope: u64, cum: u64, expiry: u64, quote: &[u8; 32]) -> [u8; crypto::MSG_LEN] {
        crypto::voucher_message(
            &self.pid.to_bytes(),
            &self.mint_b,
            &self.salt,
            &payer.to_bytes(),
            &payee.to_bytes(),
            scope,
            cum,
            expiry,
            quote,
        )
    }
    pub fn sign(&self, payer: &Keypair, payee: &Pubkey, scope: u64, cum: u64, expiry: u64, quote: &[u8; 32]) -> [u8; 64] {
        sig64(payer, &self.msg(&payer.pubkey(), payee, scope, cum, expiry, quote))
    }
}

pub fn sig64(k: &Keypair, msg: &[u8]) -> [u8; 64] {
    let s = k.sign_message(msg);
    let mut a = [0u8; 64];
    a.copy_from_slice(s.as_ref());
    a
}

pub fn quote(i: u64) -> [u8; 32] {
    solana_sdk::hash::hashv(&[b"quote", &i.to_le_bytes()]).to_bytes()
}

pub async fn init_sol(t: &mut T) -> L {
    let p = t.payer();
    t.send(vec![ix::init_ledger_sol(&t.pid, &p.pubkey())], &[]).await.unwrap();
    let ledger = ix::ledger_pda(&t.pid, &ix::SOL_MINT).0;
    let l = Ledger::unpack(&t.data(&ledger).await);
    L { pid: t.pid, ledger, mint: Pubkey::default(), mint_b: [0u8; 32], salt: l.salt, kind: KIND_SOL, spl: None }
}

pub async fn init_spl(t: &mut T, mint: &Pubkey, token_program: &Pubkey) -> Result<L, InstructionError> {
    let p = t.payer();
    let kind = if *token_program == token::TOKEN_ID { KIND_TOKEN } else { KIND_TOKEN_2022 };
    t.send(vec![ix::init_ledger_spl(&t.pid, &p.pubkey(), mint, token_program, kind)], &[]).await?;
    let ledger = ix::ledger_pda(&t.pid, &mint.to_bytes()).0;
    let vault = ix::vault_pda(&t.pid, &ledger).0;
    let l = Ledger::unpack(&t.data(&ledger).await);
    Ok(L {
        pid: t.pid,
        ledger,
        mint: *mint,
        mint_b: mint.to_bytes(),
        salt: l.salt,
        kind,
        spl: Some(SplAccounts { vault, mint: *mint, token_program: *token_program }),
    })
}

/// Opens an escrow for `payer` and deposits `amount` (SOL ledger, or from
/// `source` for SPL).
pub async fn open_and_fund(t: &mut T, l: &L, payer: &Keypair, cap: u8, amount: u64, source: Option<Pubkey>) {
    t.send(vec![ix::open_escrow(&l.pid, &l.ledger, &payer.pubkey(), cap)], &[payer]).await.unwrap();
    if amount > 0 {
        let spl = l.spl.map(|s| (source.expect("source"), s));
        t.send(vec![ix::deposit(&l.pid, &l.ledger, &payer.pubkey(), &payer.pubkey(), amount, spl)], &[payer])
            .await
            .unwrap();
    }
}

pub async fn book_with(t: &mut T, l: &L, page: u32, payees: &[&Keypair]) -> Pubkey {
    let p = t.payer();
    t.send(vec![ix::create_book(&l.pid, &l.ledger, &p.pubkey(), page)], &[]).await.unwrap();
    let book = l.book(page);
    for (i, k) in payees.iter().enumerate() {
        t.send(vec![ix::register_payee(&l.pid, &book, &k.pubkey(), i as u8)], &[k]).await.unwrap();
    }
    book
}

// ---------------------------------------------------------------------------
// State readers
// ---------------------------------------------------------------------------

pub struct EscrowView {
    pub scope: u64,
    pub balance: u64,
    pub exit_amount: u64,
    pub exit_ready: u64,
    pub pair_count: usize,
    pub pending_count: u16,
    pub open_channels: u32,
    pub pairs: Vec<([u8; 32], u64, u64, u64)>,
}

pub fn escrow_view(d: &[u8]) -> EscrowView {
    let pc = d[escrow::PAIR_COUNT] as usize;
    EscrowView {
        scope: rd_u64(d, escrow::SCOPE),
        balance: rd_u64(d, escrow::BALANCE),
        exit_amount: rd_u64(d, escrow::EXIT_AMOUNT),
        exit_ready: rd_u64(d, escrow::EXIT_READY),
        pair_count: pc,
        pending_count: rd_u16(d, escrow::PENDING_COUNT),
        open_channels: rd_u32(d, escrow::OPEN_CHANNELS),
        pairs: (0..pc)
            .map(|i| {
                let o = pair_off(i);
                (
                    rd_key(d, o),
                    rd_u64(d, o + escrow::P_SETTLED),
                    rd_u64(d, o + escrow::P_PENDING_CUM),
                    rd_u64(d, o + escrow::P_PENDING_BATCH),
                )
            })
            .collect(),
    }
}

pub async fn escrow_of(t: &mut T, l: &L, payer: &Pubkey) -> EscrowView {
    let k = l.escrow(payer);
    escrow_view(&t.data(&k).await)
}

pub async fn slot_balance(t: &mut T, book: &Pubkey, slot: usize) -> u64 {
    let d = t.data(book).await;
    rd_u64(&d, slot_off(slot) + book::S_BALANCE)
}

pub async fn ledger_of(t: &mut T, l: &L) -> Ledger {
    Ledger::unpack(&t.data(&l.ledger).await)
}

/// Global solvency: the sum of every escrow balance, channel balance, batch
/// hold and payee balance equals the ledger's liabilities, which equal vault
/// holdings minus rent.
pub async fn assert_solvent(t: &mut T, l: &L, tracked: &[Pubkey]) {
    let mut sum = 0u64;
    for k in tracked {
        let Some(a) = t.account(k).await else { continue };
        if a.owner != l.pid || a.data.len() < 8 {
            continue;
        }
        let d = &a.data;
        match &d[0..8] {
            x if x == DISC_ESCROW => sum += rd_u64(d, escrow::BALANCE),
            x if x == DISC_CHANNEL => sum += Channel::unpack(d).balance,
            x if x == DISC_BATCH => sum += BatchHdr::unpack(d).held,
            x if x == DISC_BOOK => {
                for s in 0..BOOK_SLOTS {
                    sum += rd_u64(d, slot_off(s) + book::S_BALANCE);
                }
            }
            _ => {}
        }
    }
    let lg = ledger_of(t, l).await;
    assert_eq!(sum, lg.liabilities, "sum of entries != ledger liabilities");
    let holdings = match l.spl {
        None => t.lamports(&l.ledger).await - t.rent.minimum_balance(LEDGER_LEN),
        Some(s) => token_amount(&t.data(&s.vault).await),
    };
    assert_eq!(holdings, lg.liabilities, "vault holdings != liabilities");
}

// ---------------------------------------------------------------------------
// SPL helpers (hand-built instructions)
// ---------------------------------------------------------------------------

pub fn token_amount(d: &[u8]) -> u64 {
    rd_u64(d, 64)
}

pub async fn create_mint(t: &mut T, token_program: &Pubkey, mint: &Keypair, authority: &Pubkey, ext: &[Instruction], space: usize) {
    let p = t.payer();
    let lamports = t.rent.minimum_balance(space);
    let mut ixs = vec![system_instruction::create_account(&p.pubkey(), &mint.pubkey(), lamports, space as u64, token_program)];
    ixs.extend_from_slice(ext);
    let mut d = vec![20u8, 6];
    d.extend_from_slice(authority.as_ref());
    d.push(0);
    ixs.push(Instruction {
        program_id: *token_program,
        accounts: vec![solana_sdk::instruction::AccountMeta::new(mint.pubkey(), false)],
        data: d,
    });
    t.send(ixs, &[mint]).await.unwrap();
}

pub async fn create_token_account(t: &mut T, token_program: &Pubkey, mint: &Pubkey, owner: &Pubkey) -> Pubkey {
    let p = t.payer();
    let acct = Keypair::new();
    let lamports = t.rent.minimum_balance(token::ACCOUNT_LEN);
    let ixs = vec![
        system_instruction::create_account(&p.pubkey(), &acct.pubkey(), lamports, token::ACCOUNT_LEN as u64, token_program),
        token::initialize_account3(token_program, &acct.pubkey(), mint, owner),
    ];
    t.send(ixs, &[&acct]).await.unwrap();
    acct.pubkey()
}

pub async fn mint_to(t: &mut T, token_program: &Pubkey, mint: &Pubkey, dest: &Pubkey, authority: &Keypair, amount: u64) {
    let mut d = vec![7u8];
    d.extend_from_slice(&amount.to_le_bytes());
    let i = Instruction {
        program_id: *token_program,
        accounts: vec![
            solana_sdk::instruction::AccountMeta::new(*mint, false),
            solana_sdk::instruction::AccountMeta::new(*dest, false),
            solana_sdk::instruction::AccountMeta::new_readonly(authority.pubkey(), true),
        ],
        data: d,
    };
    t.send(vec![i], &[authority]).await.unwrap();
}

// ---------------------------------------------------------------------------
// Voucher / batch helpers
// ---------------------------------------------------------------------------

pub fn wv(escrow_ix: u8, pair_ix: u8, book_ix: u8, slot: u8, cum: u64, expiry: u64, q: [u8; 32], sig: [u8; 64]) -> WireVoucher {
    WireVoucher { escrow_ix, pair_ix, book_ix, slot, cumulative: cum, expiry_slot: expiry, quote_hash: q, sig }
}

pub fn wc(channel_ix: u8, book_ix: u8, slot: u8, cum: u64, expiry: u64, q: [u8; 32], sig: [u8; 64]) -> WireClose {
    WireClose { channel_ix, book_ix, slot, cumulative: cum, expiry_slot: expiry, quote_hash: q, sig }
}

/// One voucher of a planned two-phase batch.
#[derive(Clone)]
pub struct Planned {
    pub payer: Pubkey,
    pub pair_ix: u8,
    pub slot: u8,
    pub payee: Pubkey,
    pub scope: u64,
    pub cum: u64,
    pub delta: u64,
    pub expiry: u64,
    pub quote: [u8; 32],
    pub sig: [u8; 64],
}

/// Leaves, chunk roots and the batch root of a plan.
pub struct Plan {
    pub items: Vec<Planned>,
    pub chunk_log: u8,
    pub chunk_size: u8,
    pub root: [u8; 32],
    pub chunk_roots: Vec<[u8; 32]>,
}

impl Plan {
    pub fn new(l: &L, items: Vec<Planned>, chunk_log: u8, chunk_size: u8) -> Self {
        let leaves: Vec<[u8; 32]> = items
            .iter()
            .map(|p| crypto::batch_leaf(p.delta, &l.msg(&p.payer, &p.payee, p.scope, p.cum, p.expiry, &p.quote)))
            .collect();
        let chunk_roots: Vec<[u8; 32]> = leaves
            .chunks(chunk_size as usize)
            .map(|c| crypto::subtree_root(c, chunk_log as u32))
            .collect();
        let root = Self::root_of(&chunk_roots, chunk_log);
        Plan { items, chunk_log, chunk_size, root, chunk_roots }
    }
    fn root_of(chunk_roots: &[[u8; 32]], chunk_log: u8) -> [u8; 32] {
        let d = crypto::upper_depth(chunk_roots.len() as u32);
        let mut lvl: Vec<[u8; 32]> = chunk_roots.to_vec();
        let mut zero = crypto::zero_root(chunk_log as u32);
        for _ in 0..d {
            if lvl.len() % 2 == 1 {
                lvl.push(zero);
            }
            lvl = lvl.chunks(2).map(|c| crypto::node(&c[0], &c[1])).collect();
            zero = crypto::node(&zero, &zero);
        }
        lvl[0]
    }
    pub fn proof(&self, index: usize) -> Vec<[u8; 32]> {
        let d = crypto::upper_depth(self.chunk_roots.len() as u32);
        let mut lvl: Vec<[u8; 32]> = self.chunk_roots.clone();
        let mut zero = crypto::zero_root(self.chunk_log as u32);
        let mut idx = index;
        let mut out = vec![];
        for _ in 0..d {
            if lvl.len() % 2 == 1 {
                lvl.push(zero);
            }
            out.push(lvl[idx ^ 1]);
            lvl = lvl.chunks(2).map(|c| crypto::node(&c[0], &c[1])).collect();
            zero = crypto::node(&zero, &zero);
            idx /= 2;
        }
        out
    }
    pub fn total(&self) -> u64 {
        self.items.iter().map(|p| p.delta).sum()
    }
    pub fn num_chunks(&self) -> usize {
        self.chunk_roots.len()
    }
    /// StageChunk instruction for chunk `c` (books after the escrows).
    pub fn stage_ix(&self, l: &L, batch: &Pubkey, c: usize, book: &Pubkey) -> Instruction {
        let cs = self.chunk_size as usize;
        let items = &self.items[c * cs..((c + 1) * cs).min(self.items.len())];
        let mut escrows: Vec<Pubkey> = vec![];
        for p in items {
            let e = l.escrow(&p.payer);
            if !escrows.contains(&e) {
                escrows.push(e);
            }
        }
        let book_ix = (2 + escrows.len()) as u8;
        let vs: Vec<WireVoucher> = items
            .iter()
            .map(|p| {
                let ei = 2 + escrows.iter().position(|e| *e == l.escrow(&p.payer)).unwrap();
                wv(ei as u8, p.pair_ix, book_ix, p.slot, p.cum, p.expiry, p.quote, p.sig)
            })
            .collect();
        ix::stage_chunk(&l.pid, &l.ledger, batch, &escrows, &[*book], c as u16, &self.proof(c), &vs)
    }
}

/// Plans a voucher from `payer` (pair `pair_ix`) to the payee at `slot`.
#[allow(clippy::too_many_arguments)]
pub fn planned(l: &L, payer: &Keypair, scope: u64, pair_ix: u8, payee: &Pubkey, slot: u8, settled: u64, cum: u64, expiry: u64, q: u64) -> Planned {
    let qh = quote(q);
    Planned {
        payer: payer.pubkey(),
        pair_ix,
        slot,
        payee: *payee,
        scope,
        cum,
        delta: cum - settled,
        expiry,
        quote: qh,
        sig: l.sign(payer, payee, scope, cum, expiry, &qh),
    }
}
