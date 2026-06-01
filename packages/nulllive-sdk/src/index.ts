/**
 * @parad0x_labs/nulllive-sdk
 *
 * Client-side attestation packet generation for NullLive.
 *
 * Depends only on node:crypto for hashing. Types from @solana/web3.js are
 * referenced for documentation but not imported at runtime — callers supply
 * raw Uint8Array values so this package has no hard runtime deps.
 *
 * See docs/NULLLIVE_README.md for proof-level semantics and architecture.
 */

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Attestation level — mirrors the u8 enum in the live_attestation Rust program.
 *
 * Level 1 (AppSigned):   stream bytes signed by app. Tamper-evidence only.
 * Level 2 (TeeCamera):   signing key bound to OS camera capture path (TEE).
 * Level 3 (IspPhysical): ISP-level heuristics suggest physical capture.
 *                        Research / best-effort. Not a shipped claim.
 */
export const AttestationLevel = {
  AppSigned:   1,
  TeeCamera:   2,
  IspPhysical: 3,
} as const;
export type AttestationLevel = typeof AttestationLevel[keyof typeof AttestationLevel];

/**
 * Off-chain attestation packet.
 *
 * One packet per signed frame interval. A batch of packets is assembled into
 * a Merkle tree, stored on Arweave, and the root is anchored on Solana.
 */
export interface AttestationPacket {
  /** 32-byte session ID, hex-encoded. Unique per stream session. */
  session_id:        string;
  /** SHA-256 of the raw frame bytes, hex-encoded. */
  frame_hash:        string;
  /** Monotonically increasing frame counter within the session. */
  frame_index:       number;
  /** Unix seconds at capture time. */
  capture_ts:        number;
  /** Base58-encoded public key of the attesting device. */
  device_pubkey:     string;
  /** Base58-encoded public key of the streamer's wallet. */
  streamer_pubkey:   string;
  /** Proof level for this packet. */
  attestation_level: AttestationLevel;
  /**
   * Signature of frame_hash (32 raw bytes, NOT the hex string) by device key.
   * Base58-encoded. The signing algorithm is key-type-dependent (Ed25519 for
   * Solana keypairs; P-256 for Secure Enclave keys).
   */
  signature:         string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Encode a Uint8Array as a lowercase hex string. */
function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

/** Encode a Uint8Array as a base58 string (Bitcoin alphabet). */
function toBase58(bytes: Uint8Array): string {
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const digits: number[] = [0];

  for (const byte of bytes) {
    let carry = byte;
    for (let j = 0; j < digits.length; ++j) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }

  let result = "";
  // Leading zero bytes become leading '1's.
  for (let i = 0; i < bytes.length && bytes[i] === 0; ++i) {
    result += "1";
  }
  for (let i = digits.length - 1; i >= 0; --i) {
    result += ALPHABET[digits[i]];
  }
  return result;
}

/** SHA-256 of input bytes, returns 32-byte Uint8Array. */
function sha256(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(data).digest());
}

/** Write a uint32 little-endian into buf at offset. */
function writeU32LE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset]     =  value         & 0xff;
  buf[offset + 1] = (value >>>  8) & 0xff;
  buf[offset + 2] = (value >>> 16) & 0xff;
  buf[offset + 3] = (value >>> 24) & 0xff;
}

/** Read a uint32 little-endian from buf at offset. */
function readU32LE(buf: Uint8Array, offset: number): number {
  return (
    buf[offset] |
    (buf[offset + 1] << 8) |
    (buf[offset + 2] << 16) |
    (buf[offset + 3] << 24)
  ) >>> 0;
}

/** Read a uint64 little-endian from buf at offset as a JS number. */
function readU64LE(buf: Uint8Array, offset: number): number {
  const lo = readU32LE(buf, offset);
  const hi = readU32LE(buf, offset + 4);
  // Safe for slot values up to 2^53 — Solana slots will not overflow this.
  return hi * 2 ** 32 + lo;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build an attestation packet from a captured frame.
 *
 * Call this inside your camera capture loop at the configured signing
 * interval (typically every 5–30 seconds). The caller is responsible for
 * sourcing the device keypair — on iOS/Android this is a TEE-backed key for
 * Level 2; on desktop it can be an in-memory keypair for Level 1.
 *
 * The returned packet is suitable for batching and uploading to Arweave.
 */
export async function buildAttestationPacket(params: {
  /** 32-byte session ID chosen at stream start. */
  sessionId:      Uint8Array;
  /** Raw frame bytes (e.g. a JPEG or NV21 buffer). */
  frameBytes:     Uint8Array;
  /** Monotonically increasing counter for this session. */
  frameIndex:     number;
  /** Unix seconds. Should come from a trusted clock source. */
  captureTs:      number;
  /** Device signing keypair. publicKey is 32 bytes (Ed25519). */
  deviceKeypair:  {
    publicKey: Uint8Array;
    /** Sign msg and return the 64-byte signature. */
    sign: (msg: Uint8Array) => Promise<Uint8Array>;
  };
  /** Base58-encoded streamer wallet public key. */
  streamerPubkey: string;
  level:          AttestationLevel;
}): Promise<AttestationPacket> {
  if (params.sessionId.length !== 32) {
    throw new Error("sessionId must be 32 bytes");
  }
  if (params.deviceKeypair.publicKey.length !== 32) {
    throw new Error("deviceKeypair.publicKey must be 32 bytes (Ed25519)");
  }

  const frameHash = sha256(params.frameBytes);
  const signature = await params.deviceKeypair.sign(frameHash);

  if (signature.length !== 64) {
    throw new Error("sign() must return a 64-byte Ed25519 signature");
  }

  return {
    session_id:        toHex(params.sessionId),
    frame_hash:        toHex(frameHash),
    frame_index:       params.frameIndex,
    capture_ts:        params.captureTs,
    device_pubkey:     toBase58(params.deviceKeypair.publicKey),
    streamer_pubkey:   params.streamerPubkey,
    attestation_level: params.level,
    signature:         toBase58(signature),
  };
}

/**
 * Build a Merkle root from a batch of attestation packets.
 *
 * Leaf hash for each packet: SHA-256(frame_hash_bytes || capture_ts_le_u64)
 * Interior nodes: SHA-256(left_child || right_child)
 * If the packet count is odd, the last leaf is hashed with itself.
 *
 * Returns the 32-byte Merkle root.
 */
export function buildBatchRoot(packets: AttestationPacket[]): Uint8Array {
  if (packets.length === 0) {
    throw new Error("Cannot build Merkle root from an empty batch");
  }

  // Build leaf nodes.
  let layer: Uint8Array[] = packets.map((p) => {
    const frameHashBytes = Buffer.from(p.frame_hash, "hex");
    const tsBytes = new Uint8Array(8);
    // Write capture_ts as little-endian u64.
    const lo = p.capture_ts >>> 0;
    const hi = Math.floor(p.capture_ts / 2 ** 32);
    writeU32LE(tsBytes, 0, lo);
    writeU32LE(tsBytes, 4, hi);
    const leaf = new Uint8Array(frameHashBytes.length + tsBytes.length);
    leaf.set(frameHashBytes, 0);
    leaf.set(tsBytes, frameHashBytes.length);
    return sha256(leaf);
  });

  // Reduce up the tree.
  while (layer.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < layer.length; i += 2) {
      const left  = layer[i];
      const right = i + 1 < layer.length ? layer[i + 1] : layer[i];
      const combined = new Uint8Array(64);
      combined.set(left,  0);
      combined.set(right, 32);
      next.push(sha256(combined));
    }
    layer = next;
  }

  return layer[0];
}

/**
 * Build the AnchorAttestation instruction data buffer.
 *
 * Layout (89 bytes):
 *   [0]       discriminant = 0x01
 *   [1..32]   session_id       (32 bytes)
 *   [33..64]  merkle_root      (32 bytes)
 *   [65..68]  batch_start_ts   (u32 LE)
 *   [69..72]  batch_end_ts     (u32 LE)
 *   [73..76]  frame_count      (u32 LE)
 *   [77..80]  storage_uri_hash (4 bytes)
 *   [81..88]  padding          (8 bytes, zeroed)
 *
 * Total: 1 + 88 = 89 bytes.
 */
export function buildAnchorIxData(params: {
  sessionId:       Uint8Array;
  merkleRoot:      Uint8Array;
  batchStartTs:    number;
  batchEndTs:      number;
  frameCount:      number;
  /** First 4 bytes of the Arweave transaction ID for the batch. */
  storageUriHash:  Uint8Array;
}): Uint8Array {
  if (params.sessionId.length !== 32) {
    throw new Error("sessionId must be 32 bytes");
  }
  if (params.merkleRoot.length !== 32) {
    throw new Error("merkleRoot must be 32 bytes");
  }
  if (params.storageUriHash.length !== 4) {
    throw new Error("storageUriHash must be 4 bytes");
  }

  const buf = new Uint8Array(89);
  let offset = 0;

  buf[offset] = 0x02; // discriminant for AnchorAttestation (IX_ANCHOR_ATTESTATION)
  offset += 1;

  buf.set(params.sessionId, offset);
  offset += 32;

  buf.set(params.merkleRoot, offset);
  offset += 32;

  writeU32LE(buf, offset, params.batchStartTs);
  offset += 4;

  writeU32LE(buf, offset, params.batchEndTs);
  offset += 4;

  writeU32LE(buf, offset, params.frameCount);
  offset += 4;

  buf.set(params.storageUriHash, offset);
  offset += 4;

  // 8 bytes padding, already zeroed by Uint8Array constructor.
  return buf;
}

/**
 * Build the StartStream instruction data buffer.
 *
 * Layout (66 bytes):
 *   [0]       discriminant = 0x00
 *   [1..32]   session_id        (32 bytes)
 *   [33..64]  device_pubkey     (32 bytes)
 *   [65]      attestation_level (u8)
 *
 * Total: 1 + 65 = 66 bytes.
 */
export function buildStartStreamIxData(params: {
  sessionId:        Uint8Array;
  devicePubkey:     Uint8Array;
  attestationLevel: AttestationLevel;
}): Uint8Array {
  if (params.sessionId.length !== 32) {
    throw new Error("sessionId must be 32 bytes");
  }
  if (params.devicePubkey.length !== 32) {
    throw new Error("devicePubkey must be 32 bytes");
  }
  if (
    params.attestationLevel !== AttestationLevel.AppSigned &&
    params.attestationLevel !== AttestationLevel.TeeCamera &&
    params.attestationLevel !== AttestationLevel.IspPhysical
  ) {
    throw new Error("attestationLevel must be 1, 2, or 3");
  }

  const buf = new Uint8Array(66);
  let offset = 0;

  buf[offset] = 0x01; // discriminant for StartStream (IX_START_STREAM)
  offset += 1;

  buf.set(params.sessionId, offset);
  offset += 32;

  buf.set(params.devicePubkey, offset);
  offset += 32;

  buf[offset] = params.attestationLevel;
  return buf;
}

/**
 * Build the EndStream instruction data buffer.
 *
 * Layout (33 bytes):
 *   [0]      discriminant = 0x02
 *   [1..32]  session_id (32 bytes)
 *
 * Total: 1 + 32 = 33 bytes.
 */
export function buildEndStreamIxData(sessionId: Uint8Array): Uint8Array {
  if (sessionId.length !== 32) {
    throw new Error("sessionId must be 32 bytes");
  }

  const buf = new Uint8Array(33);
  buf[0] = 0x03; // discriminant for EndStream (IX_END_STREAM)
  buf.set(sessionId, 1);
  return buf;
}

/**
 * Staleness thresholds in Solana slots.
 *
 * Solana targets ~400ms per slot. 75 slots ≈ 30 seconds (yellow threshold).
 * 225 slots ≈ 90 seconds (dark threshold).
 *
 * These match the badge UX thresholds in the README.
 */
const STALE_SLOTS  = 75;  // > 30s
const DARK_SLOTS   = 225; // > 90s

/**
 * StreamSession PDA layout (on-chain account data).
 *
 * The Solana program stores the following fields, borsh-encoded.
 * This function expects the raw account data bytes starting at byte 0.
 *
 * Layout (matches live_attestation/src/state.rs exactly):
 *   [0]        disc             (u8  = 0x4E)
 *   [1..32]    streamer_pubkey  (32 bytes)
 *   [33..64]   device_pubkey    (32 bytes)
 *   [65..96]   session_id       (32 bytes)
 *   [97..104]  started_slot     (u64 LE)
 *   [105..112] last_anchor_slot (u64 LE)
 *   [113..144] last_root        (32 bytes)
 *   [145..152] total_frame_count(u64 LE)
 *   [153]      status           (u8: 0=Active, 1=Ended)
 *   [154]      attestation_level(u8: 1/2/3)
 *   [155]      bump             (u8)
 *   [156..162] reserved
 *
 * Minimum length: 163 bytes (STREAM_SESSION_LEN).
 */
export function verifyBadge(
  sessionData: Uint8Array,
  currentSlot: number,
): {
  status:   "verified" | "stale" | "dark" | "ended";
  level:    AttestationLevel;
  slot:     number;
  ageSlots: number;
} {
  if (sessionData.length < 163) {
    return {
      status:   "dark",
      level:    AttestationLevel.AppSigned,
      slot:     0,
      ageSlots: Infinity,
    };
  }

  const isEnded        = sessionData[153] !== 0;  // SessionStatus::Ended = 1
  const rawLevel       = sessionData[154];         // attestation_level
  const lastAnchorSlot = readU64LE(sessionData, 105); // last_anchor_slot

  const level: AttestationLevel =
    rawLevel === AttestationLevel.TeeCamera   ? AttestationLevel.TeeCamera   :
    rawLevel === AttestationLevel.IspPhysical ? AttestationLevel.IspPhysical :
    AttestationLevel.AppSigned;

  if (isEnded) {
    return { status: "ended", level, slot: lastAnchorSlot, ageSlots: currentSlot - lastAnchorSlot };
  }

  const ageSlots = currentSlot - lastAnchorSlot;

  let status: "verified" | "stale" | "dark";
  if (ageSlots <= STALE_SLOTS) {
    status = "verified";
  } else if (ageSlots <= DARK_SLOTS) {
    status = "stale";
  } else {
    status = "dark";
  }

  return { status, level, slot: lastAnchorSlot, ageSlots };
}
