import assert from "node:assert/strict";

function alphaFee(realizedPnlAtomic: bigint, feeBps: bigint) {
  if (realizedPnlAtomic <= 0n) return 0n;
  return (realizedPnlAtomic * feeBps) / 10000n;
}

assert.equal(alphaFee(100000n, 100n).toString(), "1000");
assert.equal(alphaFee(0n, 100n).toString(), "0");
assert.equal(alphaFee(-100000n, 100n).toString(), "0");

console.log("alpha-monetization acceptance ok");
