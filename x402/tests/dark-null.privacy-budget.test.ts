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
// PrivacyBudget (mirrors crates/dark-privacy-budget/src/lib.rs)
//
// query_hash = SHA256("query-v1" || budget_id[32] || epsilon_le[4] || query_count_le[4])
//
// BudgetExhausted when spent + requested > total
// remaining  = total - spent
//
// Errors: BudgetExhausted, ZeroEpsilon
// ---------------------------------------------------------------------------

interface PrivacyBudget {
  budget_id: Buffer     // 32 bytes
  total: number         // u32 — total epsilon budget (scaled integer)
  spent: number         // u32 — epsilon consumed so far
  query_count: number   // u32 — number of queries issued
}

function createBudget(budget_id: Buffer, total: number): PrivacyBudget {
  if (budget_id.length !== 32) throw new Error('budget_id must be 32 bytes')
  return { budget_id: Buffer.from(budget_id), total, spent: 0, query_count: 0 }
}

function queryHash(budget: PrivacyBudget, epsilon: number): Buffer {
  return sha256(
    Buffer.from('query-v1'),
    budget.budget_id,
    u32le(epsilon),
    u32le(budget.query_count),
  )
}

function consumeBudget(budget: PrivacyBudget, epsilon: number): Buffer {
  if (epsilon === 0) throw new Error('ZeroEpsilon')
  if (budget.spent + epsilon > budget.total) throw new Error('BudgetExhausted')

  const q_hash = queryHash(budget, epsilon)
  budget.spent += epsilon
  budget.query_count += 1
  return q_hash
}

function remainingBudget(budget: PrivacyBudget): number {
  return budget.total - budget.spent
}

function publicRecord(budget: PrivacyBudget): object {
  return {
    budget_id:   budget.budget_id.toString('hex'),
    total:       budget.total,
    spent:       budget.spent,
    query_count: budget.query_count,
    mainnet_ready: false,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dark-null privacy-budget', () => {
  const BUDGET_ID = Buffer.alloc(32).fill(0x7e)

  it('consume budget succeeds and returns a valid query_hash', () => {
    const budget = createBudget(BUDGET_ID, 1000)
    const q_hash = consumeBudget(budget, 100)
    expect(q_hash.length).toBe(32)
    expect(budget.spent).toBe(100)
    expect(budget.query_count).toBe(1)
  })

  it('budget exhausted: spent + requested > total throws BudgetExhausted', () => {
    const budget = createBudget(BUDGET_ID, 500)
    consumeBudget(budget, 400)           // spent = 400
    expect(() => consumeBudget(budget, 200)).toThrow('BudgetExhausted')
    // spent must not have changed
    expect(budget.spent).toBe(400)
    expect(budget.query_count).toBe(1)
  })

  it('zero epsilon is rejected', () => {
    const budget = createBudget(BUDGET_ID, 1000)
    expect(() => consumeBudget(budget, 0)).toThrow('ZeroEpsilon')
  })

  it('multiple queries tracked: query_count increments and spent accumulates', () => {
    const budget = createBudget(BUDGET_ID, 1000)
    const epsilons = [100, 200, 150]
    for (const e of epsilons) consumeBudget(budget, e)

    expect(budget.query_count).toBe(3)
    expect(budget.spent).toBe(450)

    // Each query_hash was computed with the count at the time of the call (0, 1, 2)
    // Recompute the third hash (count was 2 before the call)
    const scratch = createBudget(BUDGET_ID, 1000)
    scratch.query_count = 2
    const expected_third = queryHash(scratch, 150)

    // We need to replay — simulate final hash from fresh budget
    const b2 = createBudget(BUDGET_ID, 1000)
    consumeBudget(b2, 100)   // count goes to 1
    consumeBudget(b2, 200)   // count goes to 2
    const third = consumeBudget(b2, 150)  // count was 2 → hash uses query_count=2

    expect(third.equals(expected_third)).toBe(true)
  })

  it('remaining_budget matches arithmetic: total - spent', () => {
    const budget = createBudget(BUDGET_ID, 800)
    consumeBudget(budget, 300)
    consumeBudget(budget, 250)
    expect(remainingBudget(budget)).toBe(250)   // 800 - 300 - 250 = 250

    // Consuming exactly the remainder should succeed
    consumeBudget(budget, 250)
    expect(remainingBudget(budget)).toBe(0)
    expect(() => consumeBudget(budget, 1)).toThrow('BudgetExhausted')
  })

  it('public record has budget_id hex + total + spent + query_count, mainnet_ready false', () => {
    const budget = createBudget(BUDGET_ID, 1000)
    consumeBudget(budget, 75)
    consumeBudget(budget, 125)

    const rec = publicRecord(budget) as Record<string, unknown>
    expect(rec['budget_id']).toBe(BUDGET_ID.toString('hex'))
    expect(rec['total']).toBe(1000)
    expect(rec['spent']).toBe(200)
    expect(rec['query_count']).toBe(2)
    expect(rec['mainnet_ready']).toBe(false)
  })
})
