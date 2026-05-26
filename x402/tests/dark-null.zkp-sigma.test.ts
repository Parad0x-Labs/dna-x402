import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------
function sha256(...bufs: Buffer[]): Buffer {
  const h = createHash('sha256')
  for (const b of bufs) h.update(b)
  return h.digest()
}

// ---------------------------------------------------------------------------
// Sigma Protocol (ZKP)
// Mirrors crates/dark-zkp-sigma/src/lib.rs
// ---------------------------------------------------------------------------

const COMMIT_TAG    = Buffer.from('sigma-commit-v1')
const CHALLENGE_TAG = Buffer.from('sigma-challenge-v1')
const RESPONSE_TAG  = Buffer.from('sigma-response-v1')
const PUBKEY_TAG    = Buffer.from('sigma-pubkey-v1')

function sigmaCommitment(secret: Buffer, proverNonce: Buffer): Buffer {
  if (secret.equals(Buffer.alloc(secret.length, 0))) {
    throw new Error('zero secret not allowed')
  }
  if (proverNonce.equals(Buffer.alloc(proverNonce.length, 0))) {
    throw new Error('zero prover nonce not allowed')
  }
  return sha256(COMMIT_TAG, secret, proverNonce)
}

function sigmaChallenge(commitment: Buffer, verifierNonce: Buffer): Buffer {
  return sha256(CHALLENGE_TAG, commitment, verifierNonce)
}

function sigmaResponse(secret: Buffer, challenge: Buffer): Buffer {
  return sha256(RESPONSE_TAG, secret, challenge)
}

function sigmaPublicKey(secret: Buffer): Buffer {
  return sha256(PUBKEY_TAG, secret)
}

interface SigmaProof {
  commitment: Buffer
  challenge: Buffer
  response: Buffer
  public_key: Buffer
}

function sigmaProve(secret: Buffer, proverNonce: Buffer, verifierNonce: Buffer): SigmaProof {
  const commitment = sigmaCommitment(secret, proverNonce)
  const challenge  = sigmaChallenge(commitment, verifierNonce)
  const response   = sigmaResponse(secret, challenge)
  const public_key = sigmaPublicKey(secret)
  return { commitment, challenge, response, public_key }
}

function sigmaVerify(proof: SigmaProof, verifierNonce: Buffer): boolean {
  const expectedChallenge = sigmaChallenge(proof.commitment, verifierNonce)
  return expectedChallenge.equals(proof.challenge)
}

const mainnet_ready = false

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('dark-null zkp-sigma', () => {
  const secret       = Buffer.from('prover-secret-32bytes-----------', 'utf8').subarray(0, 32)
  const proverNonce  = Buffer.from('prover-nonce-32bytes------------', 'utf8').subarray(0, 32)
  const verifierNonce = Buffer.from('verifier-nonce-32bytes----------', 'utf8').subarray(0, 32)

  it('mainnet_ready flag is false', () => {
    expect(mainnet_ready).toBe(false)
  })

  it('prove + verify happy path', () => {
    const proof = sigmaProve(secret, proverNonce, verifierNonce)
    expect(sigmaVerify(proof, verifierNonce)).toBe(true)
  })

  it('wrong verifier nonce causes challenge mismatch', () => {
    const proof      = sigmaProve(secret, proverNonce, verifierNonce)
    const wrongNonce = Buffer.from('wrong-verifier-nonce-32bytes----', 'utf8').subarray(0, 32)
    expect(sigmaVerify(proof, wrongNonce)).toBe(false)
  })

  it('zero secret is rejected', () => {
    expect(() => sigmaCommitment(Buffer.alloc(32, 0), proverNonce)).toThrow()
  })

  it('zero prover nonce is rejected', () => {
    expect(() => sigmaCommitment(secret, Buffer.alloc(32, 0))).toThrow()
  })

  it('same secret with different prover nonces produces different commitments', () => {
    const nonce2 = Buffer.from('different-prover-nonce-32bytes--', 'utf8').subarray(0, 32)
    const c1 = sigmaCommitment(secret, proverNonce)
    const c2 = sigmaCommitment(secret, nonce2)
    expect(c1.equals(c2)).toBe(false)
  })

  it('proof fields are internally consistent (challenge matches)', () => {
    const proof = sigmaProve(secret, proverNonce, verifierNonce)
    const recomputedChallenge = sigmaChallenge(proof.commitment, verifierNonce)
    expect(recomputedChallenge.equals(proof.challenge)).toBe(true)
  })
})
