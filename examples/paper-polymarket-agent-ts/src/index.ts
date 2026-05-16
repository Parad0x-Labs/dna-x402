const startingBalance = BigInt(process.env.PAPER_STARTING_BALANCE_ATOMIC ?? "10000000000");
const realizedPnl = 125000n;
const balance = startingBalance + realizedPnl;

console.log("paper-polymarket-agent example ok");
console.log(`balance=${balance.toString()}`);
console.log("badge=PAPER");
