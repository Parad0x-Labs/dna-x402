#!/usr/bin/env node
// x402 devnet demo — mock flow (no real SOL transfer)
// Status: MOCK — not production

import { createHash } from "node:crypto";

const DARK_NULL_X402_SCOPE = "dark_null_v1_x402_scope";
const DARK_NULL_X402_REQ = "dark_null_v1_x402_req";

function scopeHash(resourceUrl) {
  return createHash("sha256")
    .update(DARK_NULL_X402_SCOPE)
    .update(resourceUrl)
    .digest("hex");
}

function mockRequirement(resourceUrl, amountLamports, payTo, expiresAtSlot) {
  return {
    scheme: "exact",
    network: "solana-devnet",
    asset: "SOL",
    amountLamports,
    payTo,
    resource: resourceUrl,
    expiresAtSlot,
    nonce: "00000001",
  };
}

function requirementHash(req) {
  // Mirror Rust: hash domain + fields including scope_hash of resource
  const scope = scopeHash(req.resource);
  return createHash("sha256")
    .update(DARK_NULL_X402_REQ)
    .update(req.scheme)
    .update(req.network)
    .update(req.asset)
    .update(req.resource) // simplified; Rust uses scope_hash — see dark-x402-core
    .digest("hex");
}

function mockProof(req, payerPubkey) {
  const reqHash = requirementHash(req);
  return {
    requirementHash: reqHash,
    payerPubkey,
    txSignature: `MOCK_SIG_${reqHash.slice(0, 8)}`,
    scopeHash: scopeHash(req.resource),
    isMock: true,
  };
}

function mintMockReceipt(req, proof, responseBytes) {
  const receiptNoteHash = createHash("sha256")
    .update("dark_null_v1_x402_note")
    .update(proof.requirementHash)
    .update(proof.scopeHash)
    .digest("hex");
  const receiptNullifier = createHash("sha256")
    .update("dark_null_v1_x402_nullifier")
    .update(receiptNoteHash)
    .update(req.nonce)
    .digest("hex");
  const responseHash = createHash("sha256")
    .update("dark_null_v1_x402_response")
    .update(responseBytes)
    .digest("hex");
  return {
    requirementHash: proof.requirementHash,
    proofHash: createHash("sha256").update(proof.txSignature).digest("hex"),
    receiptNoteHash,
    receiptNullifier,
    serviceScopeHash: proof.scopeHash,
    responseHash,
    isMock: true,
  };
}

// Demo flow
const resource = "https://api.darknull.example/gpt4-private";
const payTo = "payee_pubkey_32bytes_aaaaaaaaaa";
const payerPubkey = "payer_pubkey_32bytes_bbbbbbbbbb";
const currentSlot = 1000;

const req = mockRequirement(resource, 1_000_000, payTo, currentSlot + 100);

console.log("=== Dark Null x402 Mock Demo ===");
console.log("[STATUS: MOCK — no real SOL transferred]");
console.log("");

console.log("1. Client requests:", resource);
console.log("");

console.log("2. Server returns: 402 Payment Required");
const reqHash = requirementHash(req);
console.log("   Requirement hash:", reqHash.slice(0, 16) + "...");
console.log("   Amount:          ", req.amountLamports, "lamports");
console.log("   Network:         ", req.network);
console.log("   Expires at slot: ", req.expiresAtSlot);
console.log("");

const proof = mockProof(req, payerPubkey);
console.log("3. Client builds mock proof");
console.log("   Tx signature:    ", proof.txSignature);
console.log("   Scope hash (URL hidden):", scopeHash(resource).slice(0, 16) + "...");
console.log("   is_mock:          true");
console.log("");

const responsePayload = Buffer.from("dark_null_service_payload");
const receipt = mintMockReceipt(req, proof, responsePayload);
console.log("4. Server verifies proof and mints DarkX402Receipt");
console.log("   receipt_nullifier:", receipt.receiptNullifier.slice(0, 16) + "...");
console.log("   service_scope_hash:", receipt.serviceScopeHash.slice(0, 16) + "...");
console.log("   response_hash:    ", receipt.responseHash.slice(0, 16) + "...");
console.log("");

console.log("5. Receipt feeds into Dark Null rollup:");
console.log("   receipt_nullifier → dark_compressed_receipts program");
console.log("   service_scope_hash → receipt-rollup-lite tree");
console.log("");

console.log("=== NOT PRODUCTION ===");
console.log("To use real devnet: set STRICT_X402_DEVNET=1 and provide real tx sig");
console.log("RPC verification not yet implemented — see docs/DARK_X402_DEVNET_FLOW.md");
