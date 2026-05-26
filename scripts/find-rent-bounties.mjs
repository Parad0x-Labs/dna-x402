#!/usr/bin/env node
/**
 * find-rent-bounties.mjs
 *
 * Prints a mock list of expired account targets with estimated reclaim value.
 * Does NOT make any network calls — all data is mock/illustrative.
 *
 * To find real expired accounts:
 *   1. Point SOLANA_RPC_URL at a devnet or mainnet RPC endpoint.
 *   2. Replace MOCK_TARGETS below with real getProgramAccounts calls.
 *   3. Filter by data_len=0 and last_modified_slot older than EXPIRY_THRESHOLD.
 *
 * Run: node scripts/find-rent-bounties.mjs
 */

const BOUNTY_BPS = 500; // 5% bounty to the finder

const MOCK_TARGETS = [
  {
    pubkey: 'DarkN1111111111111111111111111111111111111111',
    owner_program: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    data_len: 0,
    estimated_lamports: 2_039_280,
    last_modified_slot: 180_000_000,
    note: 'Abandoned token account — zero balance, no owner activity for 90+ days',
  },
  {
    pubkey: 'DarkN2222222222222222222222222222222222222222',
    owner_program: '11111111111111111111111111111111',
    data_len: 0,
    estimated_lamports: 890_880,
    last_modified_slot: 172_000_000,
    note: 'Empty system account — likely a one-time use PDA never closed',
  },
  {
    pubkey: 'DarkN3333333333333333333333333333333333333333',
    owner_program: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
    data_len: 165,
    estimated_lamports: 2_039_280,
    last_modified_slot: 168_500_000,
    note: 'Token-2022 account with zero balance — safe to close and reclaim',
  },
  {
    pubkey: 'DarkN4444444444444444444444444444444444444444',
    owner_program: 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',
    data_len: 679,
    estimated_lamports: 5_616_720,
    last_modified_slot: 155_000_000,
    note: 'Stale Metaplex metadata account — collection was burned, metadata orphaned',
  },
  {
    pubkey: 'DarkN5555555555555555555555555555555555555555',
    owner_program: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bRS',
    data_len: 0,
    estimated_lamports: 2_039_280,
    last_modified_slot: 162_000_000,
    note: 'Associated token account — token mint was burned, account stranded',
  },
];

// ---------------------------------------------------------------------------
// Compute totals
// ---------------------------------------------------------------------------
const total_lamports = MOCK_TARGETS.reduce((acc, t) => acc + t.estimated_lamports, 0);
const total_bounty   = Math.floor((total_lamports * BOUNTY_BPS) / 10_000);
const total_sol      = (total_lamports / 1e9).toFixed(6);
const bounty_sol     = (total_bounty / 1e9).toFixed(6);

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------
console.log(JSON.stringify({
  note: 'MOCK DATA — Run with devnet RPC to find real expired accounts',
  bounty_bps: BOUNTY_BPS,
  bounty_pct: `${BOUNTY_BPS / 100}%`,
  targets: MOCK_TARGETS.map(t => ({
    pubkey: t.pubkey,
    owner_program: t.owner_program,
    data_len: t.data_len,
    estimated_lamports: t.estimated_lamports,
    estimated_sol: (t.estimated_lamports / 1e9).toFixed(6),
    bounty_lamports: Math.floor((t.estimated_lamports * BOUNTY_BPS) / 10_000),
    last_modified_slot: t.last_modified_slot,
    note: t.note,
  })),
  summary: {
    total_accounts: MOCK_TARGETS.length,
    total_reclaimable_lamports: total_lamports,
    total_reclaimable_sol: total_sol,
    finder_bounty_lamports: total_bounty,
    finder_bounty_sol: bounty_sol,
  },
  how_to_find_real_targets: [
    '1. Set SOLANA_RPC_URL=https://api.devnet.solana.com',
    '2. Use getProgramAccounts with dataSize=0 filter to find empty accounts',
    '3. Filter by lamports >= 890880 (minimum rent-exempt for 0-byte account)',
    '4. Cross-reference with token mint registry to confirm burn status',
    '5. Call closeAccount instruction with this script as the fee payer',
    '6. Receive bounty_bps of reclaimed lamports as finder fee',
  ],
}, null, 2));
