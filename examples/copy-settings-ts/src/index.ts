function decide(entryPriceBps: number) {
  const min = Number(process.env.MIN_ENTRY_PRICE_BPS ?? "4000");
  const max = Number(process.env.MAX_ENTRY_PRICE_BPS ?? "6000");
  if (entryPriceBps < min) return "SKIP ENTRY_PRICE_BELOW_MIN";
  if (entryPriceBps > max) return "SKIP ENTRY_PRICE_ABOVE_MAX";
  return "COPY";
}

console.log("copy-settings example ok");
console.log(`50c=${decide(5000)}`);
console.log(`80c=${decide(8000)}`);
