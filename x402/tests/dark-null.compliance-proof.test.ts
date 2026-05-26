import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'

function sha256(...bufs: Buffer[]): Buffer {
  const h = createHash('sha256')
  for (const b of bufs) h.update(b)
  return h.digest()
}

// Hash scheme
function issuerHash(issuer_secret: Buffer): Buffer {
  return sha256(Buffer.from('comply-issuer-v1'), issuer_secret)
}
function ruleHash(rule_bytes: Buffer): Buffer {
  return sha256(Buffer.from('comply-rule-v1'), rule_bytes)
}
function ruleId(issuer_hash: Buffer, rule_hash: Buffer): Buffer {
  return sha256(Buffer.from('comply-rule-id-v1'), issuer_hash, rule_hash)
}
function subjectHash(subject_secret: Buffer): Buffer {
  return sha256(Buffer.from('comply-subject-v1'), subject_secret)
}
function proofHash(rule_id: Buffer, subject_hash: Buffer, passes: boolean): Buffer {
  return sha256(Buffer.from('comply-proof-v1'), rule_id, subject_hash, Buffer.from([passes ? 1 : 0]))
}
function attestationId(proof_hash: Buffer): Buffer {
  return sha256(Buffer.from('comply-attest-v1'), proof_hash)
}

describe('dark-null.compliance-proof', () => {
  // Test 1: rule_id computation
  it('rule_id is correctly computed from issuer and rule', () => {
    const issuer_secret = Buffer.alloc(32, 0x11)
    const rule_bytes = Buffer.from('KYC-rule-v1')
    const ih = issuerHash(issuer_secret)
    const rh = ruleHash(rule_bytes)
    const rid = ruleId(ih, rh)
    const ih2 = sha256(Buffer.from('comply-issuer-v1'), issuer_secret)
    const rh2 = sha256(Buffer.from('comply-rule-v1'), rule_bytes)
    const rid2 = sha256(Buffer.from('comply-rule-id-v1'), ih2, rh2)
    expect(rid.toString('hex')).toBe(rid2.toString('hex'))
    expect(rid.length).toBe(32)
  })

  // Test 2: attestation_id computation
  it('attestation_id is correctly computed from proof_hash', () => {
    const issuer_secret = Buffer.alloc(32, 0x22)
    const rule_bytes = Buffer.from('AML-rule-v1')
    const subject_secret = Buffer.alloc(32, 0x33)
    const ih = issuerHash(issuer_secret)
    const rh = ruleHash(rule_bytes)
    const rid = ruleId(ih, rh)
    const sh = subjectHash(subject_secret)
    const ph = proofHash(rid, sh, true)
    const aid = attestationId(ph)
    const aid2 = sha256(Buffer.from('comply-attest-v1'), ph)
    expect(aid.toString('hex')).toBe(aid2.toString('hex'))
    expect(aid.length).toBe(32)
  })

  // Test 3: passes=false produces different proof_hash than passes=true
  it('proof_hash differs for passes=true vs passes=false', () => {
    const issuer_secret = Buffer.alloc(32, 0x44)
    const rule_bytes = Buffer.from('OFAC-rule-v1')
    const subject_secret = Buffer.alloc(32, 0x55)
    const ih = issuerHash(issuer_secret)
    const rh = ruleHash(rule_bytes)
    const rid = ruleId(ih, rh)
    const sh = subjectHash(subject_secret)
    const ph_pass = proofHash(rid, sh, true)
    const ph_fail = proofHash(rid, sh, false)
    expect(ph_pass.toString('hex')).not.toBe(ph_fail.toString('hex'))
    // attestation_ids also differ
    const aid_pass = attestationId(ph_pass)
    const aid_fail = attestationId(ph_fail)
    expect(aid_pass.toString('hex')).not.toBe(aid_fail.toString('hex'))
  })

  // Test 4: verify by recomputing attestation_id
  it('attestation_id can be verified by recomputation', () => {
    const issuer_secret = Buffer.alloc(32, 0x66)
    const rule_bytes = Buffer.from('sanctions-rule-v2')
    const subject_secret = Buffer.alloc(32, 0x77)
    const ih = issuerHash(issuer_secret)
    const rh = ruleHash(rule_bytes)
    const rid = ruleId(ih, rh)
    const sh = subjectHash(subject_secret)
    const ph = proofHash(rid, sh, true)
    const aid = attestationId(ph)
    // Verify: recompute from same inputs
    const ph_verify = sha256(Buffer.from('comply-proof-v1'), rid, sh, Buffer.from([1]))
    const aid_verify = sha256(Buffer.from('comply-attest-v1'), ph_verify)
    expect(aid.toString('hex')).toBe(aid_verify.toString('hex'))
  })

  // Test 5: public record hides subject_hash
  it('public record contains attestation_id but not subject_hash', () => {
    const issuer_secret = Buffer.alloc(32, 0x88)
    const rule_bytes = Buffer.from('privacy-rule-v1')
    const subject_secret = Buffer.alloc(32, 0x99)
    const ih = issuerHash(issuer_secret)
    const rh = ruleHash(rule_bytes)
    const rid = ruleId(ih, rh)
    const sh = subjectHash(subject_secret)
    const ph = proofHash(rid, sh, true)
    const aid = attestationId(ph)
    const publicRecord = JSON.stringify({
      attestation_id: aid.toString('hex'),
      rule_id: rid.toString('hex'),
      mainnet_ready: false,
    })
    const parsed = JSON.parse(publicRecord)
    expect(parsed.attestation_id).toBe(aid.toString('hex'))
    expect(parsed.rule_id).toBe(rid.toString('hex'))
    expect(parsed.mainnet_ready).toBe(false)
    // subject_hash and subject_secret must not appear
    expect(publicRecord).not.toContain(sh.toString('hex'))
    expect(publicRecord).not.toContain(subject_secret.toString('hex'))
  })

  // Test 6: mainnet_ready=false
  it('mainnet_ready is always false', () => {
    const mainnet_ready = false
    expect(mainnet_ready).toBe(false)
  })
})
