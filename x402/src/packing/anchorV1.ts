import crypto from "node:crypto";

export const ANCHOR_V1_VERSION = 1;
export const ANCHOR_V1_FLAG_HAS_BUCKET_ID = 1 << 0;
export const ANCHOR_SIZE_BYTES = 32;
export const ANCHOR_V1_MIN_BYTES = 34; // version + flags + anchor32
export const ANCHOR_V1_WITH_BUCKET_BYTES = 42; // + u64 bucket

const U64_MASK = (1n << 64n) - 1n;

function normalizeAnchor32Hex(anchor32: string): string {
  const trimmed = anchor32.trim();
  const body = trimmed.startsWith("0x") || trimmed.startsWith("0X") ? trimmed.slice(2) : trimmed;
  if (!/^[0-9a-fA-F]{64}$/.test(body)) {
    throw new Error(`anchor32 must be 32 bytes hex (got ${anchor32.length} chars)`);
  }
  return body.toLowerCase();
}

function writeU64LE(view: DataView, offset: number, value: bigint): void {
  const normalized = value & U64_MASK;
  view.setBigUint64(offset, normalized, true);
}

function readU64LE(view: DataView, offset: number): bigint {
  return view.getBigUint64(offset, true);
}

export interface AnchorV1PayloadInput {
  anchor32: string;
  flags?: number;
  bucketId?: bigint;
}

export interface AnchorV1PayloadDecoded {
  version: number;
  flags: number;
  anchor32: string;
  bucketId?: bigint;
}

export function packAnchorV1(input: AnchorV1PayloadInput): Uint8Array {
  const anchorHex = normalizeAnchor32Hex(input.anchor32);
  const includeBucket = typeof input.bucketId === "bigint";
  const flags = (input.flags ?? 0) | (includeBucket ? ANCHOR_V1_FLAG_HAS_BUCKET_ID : 0);
  const totalLength = includeBucket ? ANCHOR_V1_WITH_BUCKET_BYTES : ANCHOR_V1_MIN_BYTES;

  const out = new Uint8Array(totalLength);
  out[0] = ANCHOR_V1_VERSION;
  out[1] = flags & 0xff;
  out.set(Buffer.from(anchorHex, "hex"), 2);

  if (includeBucket) {
    const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
    writeU64LE(view, 34, input.bucketId as bigint);
  }

  return out;
}

export function unpackAnchorV1(payload: Uint8Array): AnchorV1PayloadDecoded {
  if (payload.byteLength < ANCHOR_V1_MIN_BYTES) {
    throw new Error(`AnchorV1 payload too short: ${payload.byteLength}`);
  }

  const version = payload[0];
  if (version !== ANCHOR_V1_VERSION) {
    throw new Error(`Unsupported AnchorV1 version: ${version}`);
  }

  const flags = payload[1];
  const anchorHex = Buffer.from(payload.slice(2, 34)).toString("hex");

  if ((flags & ANCHOR_V1_FLAG_HAS_BUCKET_ID) === 0) {
    return {
      version,
      flags,
      anchor32: `0x${anchorHex}`,
    };
  }

  if (payload.byteLength < ANCHOR_V1_WITH_BUCKET_BYTES) {
    throw new Error(`AnchorV1 bucket payload too short: ${payload.byteLength}`);
  }

  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const bucketId = readU64LE(view, 34);

  return {
    version,
    flags,
    anchor32: `0x${anchorHex}`,
    bucketId,
  };
}

export function packAnchorBatchV1(anchor32List: string[]): Uint8Array {
  if (anchor32List.length === 0) {
    throw new Error("Anchor batch must contain at least one anchor.");
  }
  if (anchor32List.length > 255) {
    throw new Error("Anchor batch supports at most 255 anchors in V1.");
  }

  const out = new Uint8Array(2 + ANCHOR_SIZE_BYTES * anchor32List.length);
  out[0] = ANCHOR_V1_VERSION;
  out[1] = anchor32List.length;

  anchor32List.forEach((anchor, index) => {
    const normalized = normalizeAnchor32Hex(anchor);
    const offset = 2 + index * ANCHOR_SIZE_BYTES;
    out.set(Buffer.from(normalized, "hex"), offset);
  });

  return out;
}

export function hashAnchorAccumulator(previousRootHex: string, anchor32: string): string {
  const previous = normalizeAnchor32Hex(previousRootHex);
  const anchor = normalizeAnchor32Hex(anchor32);
  const digest = crypto.createHash("sha256")
    .update(Buffer.from(previous, "hex"))
    .update(Buffer.from(anchor, "hex"))
    .digest("hex");
  return `0x${digest}`;
}

export function foldAnchorAccumulator(anchor32List: string[], initialRoot = `0x${"00".repeat(32)}`): string {
  return anchor32List.reduce((root, anchor) => hashAnchorAccumulator(root, anchor), initialRoot);
}

export function deriveBucketIdFromUnixMs(unixMs: number, bucketSeconds = 3600): bigint {
  const bucketMs = Math.max(1, Math.floor(bucketSeconds)) * 1000;
  return BigInt(Math.floor(unixMs / bucketMs));
}
