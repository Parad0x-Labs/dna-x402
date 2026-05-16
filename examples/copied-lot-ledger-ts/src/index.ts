const lot = {
  status: "OPEN",
  alphaFeeBpsAtEntry: BigInt(process.env.ALPHA_FEE_BPS_AT_ENTRY ?? "100"),
};

function finalize(realizedPnlAtomic: bigint) {
  if (lot.status !== "OPEN") throw new Error("COPIED_LOT_ALREADY_FINALIZED");
  lot.status = realizedPnlAtomic > 0n ? "CLOSED_WIN" : realizedPnlAtomic < 0n ? "CLOSED_LOSS" : "CLOSED_BREAK_EVEN";
  return realizedPnlAtomic > 0n ? (realizedPnlAtomic * lot.alphaFeeBpsAtEntry) / 10000n : 0n;
}

const alphaFee = finalize(100000n);
let secondFinalize = "UNEXPECTED";
try {
  finalize(100000n);
} catch {
  secondFinalize = "REJECTED";
}

console.log("copied-lot-ledger example ok");
console.log(`status=${lot.status}`);
console.log(`alphaFee=${alphaFee.toString()}`);
console.log(`secondFinalize=${secondFinalize}`);
