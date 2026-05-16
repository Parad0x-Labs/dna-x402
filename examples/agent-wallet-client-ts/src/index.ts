const payload = {
  ownerWallet: process.env.OWNER_WALLET ?? "mother-wallet-public-key",
  publicKey: process.env.AGENT_WALLET_PUBLIC_KEY ?? "agent-wallet-public-key",
  chain: "SOLANA",
  keyStorage: "LOCAL_ENCRYPTED",
  backendHasPrivateKey: false,
};

if ("privateKey" in payload) {
  throw new Error("private keys must never be sent to DNA x402");
}

console.log("agent-wallet-client example ok");
console.log(`backendHasPrivateKey=${payload.backendHasPrivateKey}`);
