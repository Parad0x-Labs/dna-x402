import { describe, expect, it } from "vitest";
import {
  ANCHOR_V1_MIN_BYTES,
  ANCHOR_V1_WITH_BUCKET_BYTES,
  deriveBucketIdFromUnixMs,
  packAnchorV1,
  unpackAnchorV1,
} from "../src/packing/anchorV1.js";

describe("anchorV1 packing", () => {
  it("packs/unpacks 34-byte payload when bucket is derived on-chain", () => {
    const packed = packAnchorV1({
      anchor32: `0x${"ab".repeat(32)}`,
    });

    expect(packed.byteLength).toBe(ANCHOR_V1_MIN_BYTES);

    const decoded = unpackAnchorV1(packed);
    expect(decoded.version).toBe(1);
    expect(decoded.anchor32).toBe(`0x${"ab".repeat(32)}`);
    expect(decoded.bucketId).toBeUndefined();
  });

  it("packs/unpacks payload with explicit u64 bucket id", () => {
    const bucketId = deriveBucketIdFromUnixMs(Date.UTC(2026, 1, 16, 12, 0, 0));

    const packed = packAnchorV1({
      anchor32: `0x${"cd".repeat(32)}`,
      bucketId,
    });

    expect(packed.byteLength).toBe(ANCHOR_V1_WITH_BUCKET_BYTES);

    const decoded = unpackAnchorV1(packed);
    expect(decoded.anchor32).toBe(`0x${"cd".repeat(32)}`);
    expect(decoded.bucketId).toBe(bucketId);
  });
});
