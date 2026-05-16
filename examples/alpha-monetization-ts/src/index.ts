function alphaFee(realizedPnlAtomic: bigint, feeBps: bigint) {
  if (realizedPnlAtomic <= 0n) return 0n;
  return (realizedPnlAtomic * feeBps) / 10000n;
}

const feeBps = BigInt(process.env.ALPHA_SUCCESS_FEE_BPS ?? "100");

console.log("alpha-monetization example ok");
console.log(`fee=${alphaFee(100000n, feeBps).toString()}`);
console.log(`lossFee=${alphaFee(-100000n, feeBps).toString()}`);
