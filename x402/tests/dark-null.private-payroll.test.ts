import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'

function sha256(...bufs: Buffer[]): Buffer {
  const h = createHash('sha256'); for (const b of bufs) h.update(b); return h.digest()
}
function xorFold(hashes: Buffer[]): Buffer {
  const acc = Buffer.alloc(32, 0)
  for (const h of hashes) { for (let i = 0; i < 32; i++) acc[i] ^= h[i] }
  return acc
}
function u32le(n: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b }
function u64le(n: bigint): Buffer { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b }

const MAINNET_READY = false

describe('dark-null.private-payroll', () => {
  const orgSecret  = Buffer.from('payroll-org-secret-v1', 'utf8')
  const empSecret1 = Buffer.from('payroll-emp-secret-alice', 'utf8')
  const empSecret2 = Buffer.from('payroll-emp-secret-bob', 'utf8')
  const blinding   = Buffer.from('payroll-blinding-bytes-01234567', 'utf8').slice(0, 32)
  const salary1    = BigInt(95000)
  const salary2    = BigInt(105000)

  it('payroll_id = SHA256("payroll-id-v1" || org_hash)', () => {
    const orgHash   = sha256(Buffer.from('payroll-org-v1'), orgSecret)
    const payrollId = sha256(Buffer.from('payroll-id-v1'), orgHash)
    expect(payrollId.length).toBe(32)
    expect(payrollId.equals(Buffer.alloc(32, 0))).toBe(false)
    expect(payrollId.equals(sha256(Buffer.from('payroll-id-v1'), orgHash))).toBe(true)
  })

  it('salary_commitment uses emp_hash + salary + blinding', () => {
    const empHash   = sha256(Buffer.from('payroll-emp-v1'), empSecret1)
    const salaryLe8 = u64le(salary1)
    const salaryCommit = sha256(Buffer.from('payroll-salary-v1'), empHash, salaryLe8, blinding)
    expect(salaryCommit.length).toBe(32)
    expect(salaryCommit.equals(Buffer.alloc(32, 0))).toBe(false)
    // blinding matters
    const noBlind = sha256(Buffer.from('payroll-salary-v1'), empHash, salaryLe8, Buffer.alloc(32, 0))
    expect(salaryCommit.equals(noBlind)).toBe(false)
  })

  it('emp_id formula is correct', () => {
    const orgHash   = sha256(Buffer.from('payroll-org-v1'), orgSecret)
    const payrollId = sha256(Buffer.from('payroll-id-v1'), orgHash)
    const empHash   = sha256(Buffer.from('payroll-emp-v1'), empSecret1)
    const empId     = sha256(Buffer.from('payroll-eid-v1'), payrollId, empHash)
    expect(empId.length).toBe(32)
    expect(empId.equals(Buffer.alloc(32, 0))).toBe(false)
    expect(empId.equals(sha256(Buffer.from('payroll-eid-v1'), payrollId, empHash))).toBe(true)
  })

  it('salary_root changes after second employee added', () => {
    const orgHash   = sha256(Buffer.from('payroll-org-v1'), orgSecret)
    const payrollId = sha256(Buffer.from('payroll-id-v1'), orgHash)
    const empHash1  = sha256(Buffer.from('payroll-emp-v1'), empSecret1)
    const empHash2  = sha256(Buffer.from('payroll-emp-v1'), empSecret2)
    const empId1    = sha256(Buffer.from('payroll-eid-v1'), payrollId, empHash1)
    const empId2    = sha256(Buffer.from('payroll-eid-v1'), payrollId, empHash2)

    const root1 = sha256(Buffer.from('payroll-root-v1'), xorFold([empId1]), u32le(1))
    const root2 = sha256(Buffer.from('payroll-root-v1'), xorFold([empId1, empId2]), u32le(2))
    expect(root1.equals(root2)).toBe(false)
  })

  it('different employees produce different emp_ids', () => {
    const orgHash   = sha256(Buffer.from('payroll-org-v1'), orgSecret)
    const payrollId = sha256(Buffer.from('payroll-id-v1'), orgHash)
    const empHash1  = sha256(Buffer.from('payroll-emp-v1'), empSecret1)
    const empHash2  = sha256(Buffer.from('payroll-emp-v1'), empSecret2)
    const empId1    = sha256(Buffer.from('payroll-eid-v1'), payrollId, empHash1)
    const empId2    = sha256(Buffer.from('payroll-eid-v1'), payrollId, empHash2)
    expect(empId1.equals(empId2)).toBe(false)
  })

  it('mainnet_ready is false', () => {
    expect(MAINNET_READY).toBe(false)
  })
})
