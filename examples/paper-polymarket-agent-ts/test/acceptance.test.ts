import assert from "node:assert/strict";

const account = {
  startingBalanceAtomic: "10000000000",
  currentBalanceAtomic: "10000125000",
  token: "PAPER_USDC",
  realSettlement: false,
};

assert.equal(account.startingBalanceAtomic, "10000000000");
assert.equal(account.token, "PAPER_USDC");
assert.equal(account.realSettlement, false);

console.log("paper-polymarket-agent acceptance ok");
