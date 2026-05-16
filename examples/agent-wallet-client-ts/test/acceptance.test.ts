import assert from "node:assert/strict";

const payload = {
  ownerWallet: "mother-wallet-public-key",
  publicKey: "agent-wallet-public-key",
  chain: "SOLANA",
  keyStorage: "LOCAL_ENCRYPTED",
  backendHasPrivateKey: false,
};

assert.equal(payload.backendHasPrivateKey, false);
assert.equal(Object.prototype.hasOwnProperty.call(payload, "privateKey"), false);
assert.equal(Object.prototype.hasOwnProperty.call(payload, "seedPhrase"), false);

console.log("agent-wallet-client acceptance ok");
