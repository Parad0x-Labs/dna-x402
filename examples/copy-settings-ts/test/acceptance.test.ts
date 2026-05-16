import assert from "node:assert/strict";

function decide(entryPriceBps: number) {
  if (entryPriceBps < 4000) return { decision: "SKIP", reason: "ENTRY_PRICE_BELOW_MIN" };
  if (entryPriceBps > 6000) return { decision: "SKIP", reason: "ENTRY_PRICE_ABOVE_MAX" };
  return { decision: "COPY", reason: "COPY_ENABLED" };
}

assert.equal(decide(5000).decision, "COPY");
assert.equal(decide(8000).reason, "ENTRY_PRICE_ABOVE_MAX");

console.log("copy-settings acceptance ok");
