#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  MAINNET_USDC_MINT,
  assertWorkspacePath,
  defaultKeysDir,
  ensureDir,
  keypairSecretBase58,
  publicKeyForFile,
  shortBase58,
  writeJsonFile,
  writeKeypairIfMissing,
} from "./proof-utils.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseFlagValue(args, flag) {
  const index = args.indexOf(flag);
  if (index === -1 || index + 1 >= args.length) {
    return undefined;
  }
  return args[index + 1];
}

function hasFlag(args, flag) {
  return args.includes(flag);
}

function normalizeCluster(value) {
  const cluster = (value ?? "mainnet").toLowerCase();
  if (cluster === "mainnet" || cluster === "mainnet-beta") {
    return "mainnet";
  }
  if (cluster === "devnet") {
    return "devnet";
  }
  throw new Error(`unsupported cluster for proof keys: ${value}`);
}

function secretHex(bytes = 32) {
  return crypto.randomBytes(bytes).toString("hex");
}

function keyPath(keysDir, name) {
  return path.join(keysDir, `${name}.json`);
}

function ensureNamedKey(keysDir, name) {
  const filePath = keyPath(keysDir, name);
  const keypair = writeKeypairIfMissing(filePath);
  return {
    name,
    path: filePath,
    pubkey: keypair.publicKey.toBase58(),
  };
}

function writeRuntimeEnv(keysDir, cluster, keys) {
  const deployer = keys.find((entry) => entry.name === "deployer");
  const anchoring = keys.find((entry) => entry.name === "anchoring");
  const receiptSigner = writeKeypairIfMissing(keyPath(keysDir, "receipt-signer"));
  const rpc = cluster === "mainnet" ? "https://api.mainnet-beta.solana.com" : "https://api.devnet.solana.com";
  const clusterLabel = cluster === "mainnet" ? "mainnet-beta" : "devnet";
  const receiptAnchorProgram = "6HSRGivdYR5D7yTDy1TFMCM8h3LzXxRtKU1RA3RnCMRN";
  const runtimeEnvPath = path.join(keysDir, "runtime.env");
  const templatePath = path.join(keysDir, "runtime.env.template");

  const runtimeLines = [
    `CLUSTER=${clusterLabel}`,
    `SOLANA_RPC_URL=${rpc}`,
    cluster === "mainnet" ? "HELIUS_RPC=" : "",
    `USDC_MINT=${cluster === "mainnet" ? MAINNET_USDC_MINT : "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"}`,
    `PAYMENT_RECIPIENT=${deployer.pubkey}`,
    `MAINNET_DEPLOYER_KEYPAIR=${deployer.path}`,
    `GAUNTLET_FUNDER_KEYPAIR=${deployer.path}`,
    `ANCHORING_KEYPAIR_PATH=${anchoring.path}`,
    `RECEIPT_ANCHOR_PROGRAM_ID=${receiptAnchorProgram}`,
    "ANCHORING_ENABLED=1",
    "ANCHORING_IMMEDIATE=1",
    `ANCHORING_SIGNATURE_LOG_PATH=${path.join(keysDir, "anchor-signatures.log")}`,
    `ADMIN_SECRET=${secretHex(32)}`,
    `RECEIPT_SIGNING_SECRET=${keypairSecretBase58(receiptSigner)}`,
    "ALLOW_INSECURE=0",
    "UNSAFE_UNVERIFIED_NETTING_ENABLED=0",
    "AUDIT_FIXTURES=0",
    "GAUNTLET_MODE=0",
    "PORT=8080",
    "",
  ].filter((line) => line !== "");

  const templateLines = runtimeLines.map((line) => {
    if (line.startsWith("HELIUS_RPC=")) {
      return "HELIUS_RPC=YOUR_PRIVATE_MAINNET_RPC_URL";
    }
    if (line.startsWith("ADMIN_SECRET=")) {
      return "ADMIN_SECRET=REPLACE_WITH_32_BYTE_HEX_SECRET";
    }
    if (line.startsWith("RECEIPT_SIGNING_SECRET=")) {
      return "RECEIPT_SIGNING_SECRET=REPLACE_WITH_BASE58_ED25519_SECRET";
    }
    return line;
  });

  fs.writeFileSync(assertWorkspacePath(runtimeEnvPath), `${runtimeLines.join("\n")}\n`);
  fs.writeFileSync(assertWorkspacePath(templatePath), `${templateLines.join("\n")}\n`);
  return { runtimeEnvPath, templatePath };
}

function main() {
  const args = process.argv.slice(2);
  const cluster = normalizeCluster(parseFlagValue(args, "--cluster"));
  const keysDir = assertWorkspacePath(parseFlagValue(args, "--keys-dir") ?? defaultKeysDir(cluster));
  const includeMayhem = !hasFlag(args, "--no-mayhem");
  ensureDir(keysDir);

  const keyNames = [
    "deployer",
    "anchoring",
    "seller-provider",
    "buyer-agent-1",
    "buyer-agent-2",
    "buyer-agent-3",
  ];
  const keys = keyNames.map((name) => ensureNamedKey(keysDir, name));

  if (includeMayhem) {
    const mayhemDir = path.join(keysDir, "mayhem-agents");
    ensureDir(mayhemDir);
    for (let i = 1; i <= 30; i += 1) {
      keys.push(ensureNamedKey(mayhemDir, `netting-${String(i).padStart(2, "0")}`));
    }
    for (let i = 1; i <= 20; i += 1) {
      keys.push(ensureNamedKey(mayhemDir, `transfer-${String(i).padStart(2, "0")}`));
    }
  }

  const allKeys = {};
  for (const entry of keys) {
    allKeys[entry.name] = {
      pubkey: publicKeyForFile(entry.path),
      path: entry.path,
    };
  }
  writeJsonFile(path.join(keysDir, "ALL_KEYS.json"), allKeys);
  writeJsonFile(path.join(keysDir, "PUBLIC_KEYS.json"), {
    generatedAt: new Date().toISOString(),
    cluster,
    keys: Object.fromEntries(Object.entries(allKeys).map(([name, entry]) => [name, entry.pubkey])),
  });

  const envPaths = writeRuntimeEnv(keysDir, cluster, keys);

  const deployer = allKeys.deployer.pubkey;
  const anchoring = allKeys.anchoring.pubkey;
  console.log(JSON.stringify({
    ok: true,
    cluster,
    keysDir,
    publicKeys: {
      deployer,
      anchoring,
      sellerProvider: allKeys["seller-provider"].pubkey,
    },
    runtimeEnvPath: envPaths.runtimeEnvPath,
    runtimeEnvTemplatePath: envPaths.templatePath,
    funding: cluster === "mainnet"
      ? {
        deployerPubkey: deployer,
        requiredMinimum: {
          sol: "0.25",
          usdc: "6.0",
          usdcMint: MAINNET_USDC_MINT,
        },
        note: `Fund only this public key: ${shortBase58(deployer)}. No private key material was printed.`,
      }
      : {
        deployerPubkey: deployer,
        note: "Use the devnet airdrop gate to fund this G-local keypair.",
      },
  }, null, 2));
}

main();
