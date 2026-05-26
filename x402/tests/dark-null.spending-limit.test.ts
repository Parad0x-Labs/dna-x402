import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sha256(...bufs: Buffer[]): Buffer {
  const h = createHash('sha256'); for (const b of bufs) h.update(b); return h.digest()
}
function u64le(n: bigint): Buffer { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b }
function u32le(n: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b }
function u8(n: number): Buffer { return Buffer.from([n]) }
function i64le(n: bigint): Buffer { const b = Buffer.alloc(8); b.writeBigInt64LE(n); return b }

// ---------------------------------------------------------------------------
// SpendingLimit (mirrors crates/dark-spending-limit/src/lib.rs)
//
// SpendingAccount: { account_id: Buffer(32), cumulative_spend: bigint,
//                    cap_lamports: bigint, epoch: bigint }
//
// receipt_hash = SHA256("spend-receipt-v1" || account_id[32] || amount_le[8]
//                        || new_total_le[8] || epoch_le[8])
//
// Errors: CapExceeded, ZeroAmount
// ---------------------------------------------------------------------------

interface SpendingAccount {
  account_id: Buffer        // 32 bytes
  cumulative_spend: bigint
  cap_lamports: bigint
  epoch: bigint
}

function createAccount(
  account_id: Buffer,
  cap_lamports: bigint,
  epoch = 0n,
): SpendingAccount {
  if (account_id.length !== 32) throw new Error('account_id must be 32 bytes')
  return { account_id: Buffer.from(account_id), cumulative_spend: 0n, cap_lamports, epoch }
}

function receiptHash(
  account_id: Buffer,
  amount: bigint,
  new_total: bigint,
  epoch: bigint,
): Buffer {
  return sha256(
    Buffer.from('spend-receipt-v1'),
    account_id,
    u64le(amount),
    u64le(new_total),
    u64le(epoch),
  )
}

function recordSpend(account: SpendingAccount, amount: bigint): Buffer {
  if (amount === 0n) throw new Error('ZeroAmount')
  const new_total = account.cumulative_spend + amount
  if (new_total > account.cap_lamports) throw new Error('CapExceeded')
  account.cumulative_spend = new_total
  return receiptHash(account.account_id, amount, new_total, account.epoch)
}

function resetEpoch(account: SpendingAccount, new_epoch: bigint): void {
  account.cumulative_spend = 0n
  account.epoch = new_epoch
}

function publicRecord(account: SpendingAccount): object {
  return {
    account_id: account.account_id.toString('hex'),
    cumulative_spend: account.cumulative_spend.toString(),
    cap_lamports: account.cap_lamports.toString(),
    epoch: account.epoch.toString(),
    mainnet_ready: false,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dark-null spending-limit', () => {
  const ACCOUNT_ID = Buffer.alloc(32).fill(0xab)

  it('record spend succeeds and receipt_hash is correct', () => {
    const acct = createAccount(ACCOUNT_ID, 1_000_000n)
    const amount = 250_000n
    const receipt = recordSpend(acct, amount)

    expect(acct.cumulative_spend).toBe(250_000n)
    expect(receipt.length).toBe(32)

    // Recompute expected hash independently
    const expected = receiptHash(ACCOUNT_ID, amount, 250_000n, 0n)
    expect(receipt.equals(expected)).toBe(true)
  })

  it('cap exceeded: cumulative + amount > cap throws CapExceeded', () => {
    const acct = createAccount(ACCOUNT_ID, 500_000n)
    recordSpend(acct, 400_000n)                          // cumulative = 400 000
    expect(() => recordSpend(acct, 200_000n)).toThrow('CapExceeded')
    // cumulative must not have changed
    expect(acct.cumulative_spend).toBe(400_000n)
  })

  it('zero amount is rejected', () => {
    const acct = createAccount(ACCOUNT_ID, 1_000_000n)
    expect(() => recordSpend(acct, 0n)).toThrow('ZeroAmount')
  })

  it('reset_epoch clears cumulative_spend to 0', () => {
    const acct = createAccount(ACCOUNT_ID, 1_000_000n, 3n)
    recordSpend(acct, 500_000n)
    expect(acct.cumulative_spend).toBe(500_000n)

    resetEpoch(acct, 4n)
    expect(acct.cumulative_spend).toBe(0n)
    expect(acct.epoch).toBe(4n)

    // Should be able to spend the full cap again
    const receipt = recordSpend(acct, 1_000_000n)
    expect(acct.cumulative_spend).toBe(1_000_000n)
    expect(receipt.length).toBe(32)
  })

  it('multiple spends accumulate correctly', () => {
    const acct = createAccount(ACCOUNT_ID, 1_000_000n)
    const amounts = [100_000n, 200_000n, 300_000n]
    for (const a of amounts) recordSpend(acct, a)
    expect(acct.cumulative_spend).toBe(600_000n)

    // One more to reach exactly the cap
    recordSpend(acct, 400_000n)
    expect(acct.cumulative_spend).toBe(1_000_000n)

    // Now any further spend should fail
    expect(() => recordSpend(acct, 1n)).toThrow('CapExceeded')
  })

  it('public record contains account_id hex + cumulative + cap + epoch, mainnet_ready false', () => {
    const acct = createAccount(ACCOUNT_ID, 2_000_000n, 7n)
    recordSpend(acct, 123_456n)

    const rec = publicRecord(acct) as Record<string, unknown>
    expect(rec['account_id']).toBe(ACCOUNT_ID.toString('hex'))
    expect(rec['cumulative_spend']).toBe('123456')
    expect(rec['cap_lamports']).toBe('2000000')
    expect(rec['epoch']).toBe('7')
    expect(rec['mainnet_ready']).toBe(false)
  })
})
