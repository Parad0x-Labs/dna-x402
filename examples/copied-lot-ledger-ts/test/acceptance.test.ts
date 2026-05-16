import assert from "node:assert/strict";

const lot = {
  status: "OPEN",
  alphaFeeBpsAtEntry: 100n,
};

function finalize(realizedPnlAtomic: bigint) {
  if (lot.status !== "OPEN") throw new Error("COPIED_LOT_ALREADY_FINALIZED");
  lot.status = realizedPnlAtomic > 0n ? "CLOSED_WIN" : realizedPnlAtomic < 0n ? "CLOSED_LOSS" : "CLOSED_BREAK_EVEN";
  return realizedPnlAtomic > 0n ? (realizedPnlAtomic * lot.alphaFeeBpsAtEntry) / 10000n : 0n;
}

assert.equal(finalize(100000n).toString(), "1000");
assert.equal(lot.status, "CLOSED_WIN");
assert.throws(() => finalize(100000n), /COPIED_LOT_ALREADY_FINALIZED/);

console.log("copied-lot-ledger acceptance ok");
