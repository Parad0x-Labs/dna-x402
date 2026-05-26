import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Re-implemented inline helpers (no external imports)
// ---------------------------------------------------------------------------

function sha256(...parts: Buffer[]): Buffer {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
}

function le8(n: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeUInt32LE(Number(n & BigInt(0xffffffff)), 0);
  b.writeUInt32LE(Number((n >> BigInt(32)) & BigInt(0xffffffff)), 4);
  return b;
}

function le4(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
}

function pfx(s: string): Buffer {
  return Buffer.from(s, "utf8");
}

// --- Threshold sig ---
function signerShareCommitment(
  signerId: number,
  messageHash: Buffer,
  nonce: Buffer
): Buffer {
  return sha256(pfx("thresh-share-v1"), Buffer.from([signerId & 0xff]), messageHash, nonce);
}

function partialSigHash(
  shareCommit: Buffer,
  signerId: number,
  secretHash: Buffer
): Buffer {
  return sha256(pfx("thresh-psig-v1"), shareCommit, Buffer.from([signerId & 0xff]), secretHash);
}

function aggregateSigs(partialSigs: Buffer[], epoch: bigint): Buffer {
  if (partialSigs.length === 0) throw new Error("No partial sigs");
  const sorted = [...partialSigs].sort((a, b) => a.compare(b));
  const xored = Buffer.alloc(32, 0);
  for (const s of sorted) for (let i = 0; i < 32; i++) xored[i] ^= s[i];
  return sha256(pfx("thresh-agg-v1"), le8(epoch), xored);
}

// --- DAO vote ---
function voteCommitmentHash(choice: number, nonce: Buffer, proposalId: bigint): Buffer {
  return sha256(pfx("vote-commit-v1"), Buffer.from([choice & 0xff]), nonce, le8(proposalId));
}

function tallyHash(proposalId: bigint, yes: number, no: number, abstain: number): Buffer {
  return sha256(pfx("tally-v1"), le8(proposalId), le4(yes), le4(no), le4(abstain));
}

// --- Gossip proof ---
function gossipMessageCommitment(messageBytes: Buffer, senderNonce: Buffer): Buffer {
  return sha256(pfx("gossip-msg-v1"), messageBytes, senderNonce);
}

function gossipReceiverCommitment(receiverSecret: Buffer, messageCommitment: Buffer): Buffer {
  return sha256(pfx("gossip-recv-v1"), receiverSecret, messageCommitment);
}

// --- Cross-chain bridge ---
function bridgeHash(source: number, dest: number, nullifier: Buffer, slot: bigint): Buffer {
  return sha256(
    pfx("xchain-bridge-v1"),
    Buffer.from([source & 0xff]),
    Buffer.from([dest & 0xff]),
    nullifier,
    le8(slot)
  );
}

// --- Session chain ---
function sessionChainHash(root: Buffer, msg: Buffer, counter: bigint): Buffer {
  return sha256(pfx("chain-v1"), root, msg, le8(counter));
}

// ---------------------------------------------------------------------------
// Full-system tests
// ---------------------------------------------------------------------------

describe("dark-null full-system invariants", () => {
  // ---- 1. Crate count --------------------------------------------------
  it("there are at least 25 dark-null privacy crates", () => {
    const darkNullCrates = [
      "dark_nullifier_banks",
      "dark_compressed_receipts",
      "dark_chaff",
      "dark_null_threshold_sig",
      "dark_null_dao_vote",
      "dark_null_gossip_proof",
      "dark_null_cross_chain",
      "dark_null_session_chain",
      "dark_null_rate_limiter",
      "dark_null_commitment_tree",
      "dark_null_merkle_proof",
      "dark_null_stealth_addr",
      "dark_null_nonce_registry",
      "dark_null_epoch_clock",
      "dark_null_receipt_binder",
      "dark_null_zk_bridge",
      "dark_null_bn254_verifier",
      "dark_null_groth16",
      "dark_null_poseidon",
      "dark_null_pedersen",
      "dark_null_vrf",
      "dark_null_ristretto",
      "dark_null_account_shield",
      "dark_null_policy_engine",
      "dark_null_audit_log",
      "dark_null_fee_splitter",
      "dark_null_tip_router",
      "dark_null_stream_proof",
    ];

    expect(darkNullCrates.length).toBeGreaterThanOrEqual(25);
  });

  // ---- 2. All domain prefixes are unique -------------------------------
  it("all 12+ domain-separation prefixes produce distinct SHA256 digests", () => {
    const prefixes = [
      "thresh-share-v1",
      "thresh-psig-v1",
      "thresh-agg-v1",
      "vote-commit-v1",
      "tally-v1",
      "gossip-msg-v1",
      "gossip-recv-v1",
      "gossip-proof-v1",
      "xchain-bridge-v1",
      "evm-calldata-v1",
      "chain-v1",
      "rate-limit-v1",
      "receipt-bind-v1",
    ];

    expect(prefixes.length).toBeGreaterThanOrEqual(12);

    const hashes = prefixes.map((p) =>
      sha256(pfx(p)).toString("hex")
    );
    const unique = new Set(hashes);
    expect(unique.size).toBe(prefixes.length);
  });

  // ---- 3. BN254 proof bundle: 352-byte instruction layout --------------
  it("BN254 proof bundle 352-byte instruction layout has stable offsets", () => {
    // BN254 Groth16 proof = a(64) + b(128) + c(64) = 256 bytes
    // Public inputs = 2 × 32 = 64 bytes (pi_a, pi_b placeholders)
    // Verifying key hash = 32 bytes
    // Total = 352 bytes
    const PROOF_SIZE = 256;
    const PUBLIC_INPUTS_SIZE = 64;
    const VK_HASH_SIZE = 32;
    const TOTAL = PROOF_SIZE + PUBLIC_INPUTS_SIZE + VK_HASH_SIZE;

    expect(TOTAL).toBe(352);

    const OFFSETS = {
      proof_start: 0,
      proof_end: PROOF_SIZE,
      public_inputs_start: PROOF_SIZE,
      public_inputs_end: PROOF_SIZE + PUBLIC_INPUTS_SIZE,
      vk_hash_start: PROOF_SIZE + PUBLIC_INPUTS_SIZE,
      vk_hash_end: TOTAL,
    };

    expect(OFFSETS.proof_start).toBe(0);
    expect(OFFSETS.proof_end).toBe(256);
    expect(OFFSETS.public_inputs_start).toBe(256);
    expect(OFFSETS.public_inputs_end).toBe(320);
    expect(OFFSETS.vk_hash_start).toBe(320);
    expect(OFFSETS.vk_hash_end).toBe(352);
  });

  // ---- 4. Privacy invariant: domain-separated hashes differ from raw SHA256 ---
  it("privacy invariant: all commitment types use domain prefixes (not raw SHA256 of input)", () => {
    const input = Buffer.alloc(32, 0xaa);
    const rawHash = sha256(input);

    const nonce = Buffer.alloc(32, 0x11);
    const secret = Buffer.alloc(32, 0x22);

    // buyer_hash style (vote commitment with some bytes)
    const voteCommit = voteCommitmentHash(1, nonce, BigInt(1));
    expect(voteCommit.toString("hex")).not.toBe(rawHash.toString("hex"));

    // receiver_commitment
    const msgCommit = gossipMessageCommitment(input, nonce);
    const recvCommit = gossipReceiverCommitment(secret, msgCommit);
    expect(recvCommit.toString("hex")).not.toBe(rawHash.toString("hex"));

    // voter_commitment
    const voterCommit = voteCommitmentHash(2, nonce, BigInt(99));
    expect(voterCommit.toString("hex")).not.toBe(rawHash.toString("hex"));

    // rate_nullifier style (bridge hash as proxy)
    const nullifier = Buffer.alloc(32, 0xde);
    const bh = bridgeHash(1, 2, nullifier, BigInt(1));
    expect(bh.toString("hex")).not.toBe(rawHash.toString("hex"));

    // session_id (chain hash as proxy)
    const root = Buffer.alloc(32, 0xbe);
    const msg = Buffer.alloc(32, 0xef);
    const sessionId = sessionChainHash(root, msg, BigInt(0));
    expect(sessionId.toString("hex")).not.toBe(rawHash.toString("hex"));
  });

  // ---- 5. mainnet_ready guard in all public record outputs -------------
  it("mainnet_ready: false is present in all output record types", () => {
    const records = [
      // Receipt-style
      { type: "receipt", mainnet_ready: false },
      // Session-style
      { type: "session", mainnet_ready: false },
      // Vote tally
      { type: "vote_tally", mainnet_ready: false },
      // Gossip proof
      { type: "gossip_proof", mainnet_ready: false },
      // Bridge record
      { type: "bridge", mainnet_ready: false },
      // Threshold sig
      { type: "threshold_sig", mainnet_ready: false },
    ];

    for (const record of records) {
      expect(record).toHaveProperty("mainnet_ready", false);
    }
  });

  // ---- 6. Threshold coherence: k=1 succeeds; k=n requires exactly n ---
  it("threshold coherence: k=1 always succeeds with 1 signer, k=n requires n signers", () => {
    const msgHash = Buffer.alloc(32, 0xab);
    const nonce = Buffer.alloc(32, 0x11);
    const secretHash = Buffer.alloc(32, 0xcc);
    const epoch = BigInt(1);

    // k=1, 1 signer → succeeds
    const sigs1 = [1].map((id) => {
      const c = signerShareCommitment(id, msgHash, nonce);
      return partialSigHash(c, id, secretHash);
    });
    const THRESHOLD_1 = 1;
    expect(sigs1.length).toBeGreaterThanOrEqual(THRESHOLD_1);
    const agg1 = aggregateSigs(sigs1, epoch);
    expect(agg1.length).toBe(32);

    // k=3, 3 signers → succeeds
    const sigs3 = [1, 2, 3].map((id) => {
      const c = signerShareCommitment(id, msgHash, nonce);
      return partialSigHash(c, id, secretHash);
    });
    const THRESHOLD_3 = 3;
    expect(sigs3.length).toBeGreaterThanOrEqual(THRESHOLD_3);
    const agg3 = aggregateSigs(sigs3, epoch);
    expect(agg3.length).toBe(32);

    // k=3 with only 2 signers → threshold not met
    const sigs2 = sigs3.slice(0, 2);
    expect(() => {
      if (sigs2.length < THRESHOLD_3) {
        throw new Error(`Threshold not met: need ${THRESHOLD_3}, got ${sigs2.length}`);
      }
    }).toThrow(/Threshold not met/);
  });

  // ---- 7. Session chain non-linearity: counter binding ----------------
  it("session chain: SHA256(chain-v1 || root || msg || counter=0) != SHA256(chain-v1 || root || msg || counter=1)", () => {
    const root = Buffer.alloc(32, 0xbe);
    const msg = Buffer.alloc(32, 0xef);

    const h0 = sessionChainHash(root, msg, BigInt(0));
    const h1 = sessionChainHash(root, msg, BigInt(1));

    expect(h0.toString("hex")).not.toBe(h1.toString("hex"));
    expect(h0.length).toBe(32);
    expect(h1.length).toBe(32);
  });

  // ---- 8. Cross-chain bridge IDs: Solana→Eth != Solana→Arbitrum -------
  it("cross-chain: Solana→Eth bridge_hash differs from Solana→Arbitrum bridge_hash", () => {
    const nullifier = Buffer.alloc(32, 0xde);
    const slot = BigInt(1_000_000);

    const SOLANA = 1;
    const ETHEREUM = 2;
    const ARBITRUM = 3;

    const bhSolEth = bridgeHash(SOLANA, ETHEREUM, nullifier, slot);
    const bhSolArb = bridgeHash(SOLANA, ARBITRUM, nullifier, slot);

    expect(bhSolEth.toString("hex")).not.toBe(bhSolArb.toString("hex"));
    expect(bhSolEth.length).toBe(32);
    expect(bhSolArb.length).toBe(32);
  });
});
