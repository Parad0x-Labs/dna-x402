import { Buffer } from "buffer";
import { RelayClient } from "@polymarket/builder-relayer-client";
import { BuilderConfig } from "@polymarket/builder-signing-sdk";
import { Chain, ClobClient, Side, SignatureTypeV2 } from "@polymarket/clob-client-v2";
import { createWalletClient, custom } from "viem";
import { polygon } from "viem/chains";

declare global {
  interface Window {
    ethereum?: any;
  }
}

(globalThis as any).Buffer ??= Buffer;

interface Phase0Config {
  relayerUrl: string;
  clobApiUrl: string;
  ownerSignerSource: string;
  builderCode: string;
  builderSignUrl: string;
  builderSignToken: string;
  chainId: number;
  expectedSignatureType: number;
}

const logEl = document.querySelector<HTMLPreElement>("#log")!;
const connectButton = document.querySelector<HTMLButtonElement>("#connect")!;
const deriveButton = document.querySelector<HTMLButtonElement>("#derive")!;
const signButton = document.querySelector<HTMLButtonElement>("#sign")!;
const deployButton = document.querySelector<HTMLButtonElement>("#deploy")!;

let config: Phase0Config;
let ownerAddress = "";
let depositWalletAddress = "";
let walletClient: any;
let relayer: RelayClient;
let clob: ClobClient;

function log(message: string, data?: unknown): void {
  const line = data === undefined ? message : `${message}\n${JSON.stringify(data, null, 2)}`;
  logEl.textContent = `${line}\n\n${logEl.textContent ?? ""}`;
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value.toLowerCase());
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function ensurePolygonNetwork(): Promise<void> {
  if (!window.ethereum) {
    throw new Error("No EVM wallet detected. Use MetaMask, Rabby, or Phantom EVM.");
  }
  const targetChainId = "0x89";
  const currentChainId = await window.ethereum.request({ method: "eth_chainId" });
  if (String(currentChainId).toLowerCase() === targetChainId) {
    log("Wallet is connected to Polygon", { chainId: 137 });
    return;
  }

  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: targetChainId }],
    });
  } catch (error: any) {
    if (error?.code !== 4902) {
      throw error;
    }
    await window.ethereum.request({
      method: "wallet_addEthereumChain",
      params: [{
        chainId: targetChainId,
        chainName: "Polygon Mainnet",
        nativeCurrency: { name: "POL", symbol: "POL", decimals: 18 },
        rpcUrls: ["https://polygon-rpc.com"],
        blockExplorerUrls: ["https://polygonscan.com"],
      }],
    });
  }

  const switchedChainId = await window.ethereum.request({ method: "eth_chainId" });
  if (String(switchedChainId).toLowerCase() !== targetChainId) {
    throw new Error(`Wallet must be on Polygon chain 137, got ${switchedChainId}.`);
  }
  log("Switched wallet to Polygon", { chainId: 137 });
}

async function redactSignedOrder(order: unknown): Promise<{ redacted: any; signaturePresent: boolean }> {
  const redacted = JSON.parse(JSON.stringify(order));
  const body = redacted.order && typeof redacted.order === "object" ? redacted.order : redacted;
  const signature = typeof body.signature === "string" ? body.signature : "";
  if (signature) {
    body.signature = `[redacted:${await sha256(signature)}]`;
  }
  for (const key of ["maker", "signer", "taker", "tokenId", "tokenID"]) {
    if (typeof body[key] === "string" && body[key]) {
      body[`${key}Hash`] = await sha256(body[key]);
      body[key] = "[redacted]";
    }
  }
  return { redacted, signaturePresent: Boolean(signature) };
}

async function saveSnapshot(payload: unknown): Promise<string> {
  const response = await fetch("/phase0-snapshot", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await response.json();
  if (!response.ok || !body.ok) {
    throw new Error(body.error ?? "snapshot save failed");
  }
  return body.snapshotPath;
}

async function setupClients(): Promise<void> {
  const builderConfig = new BuilderConfig({
    remoteBuilderConfig: {
      url: new URL(config.builderSignUrl, window.location.origin).toString(),
      token: config.builderSignToken,
    },
  });
  relayer = new RelayClient(config.relayerUrl, config.chainId, walletClient, builderConfig as any);
  clob = new ClobClient({
    host: config.clobApiUrl,
    chain: Chain.POLYGON,
    signer: walletClient,
    signatureType: SignatureTypeV2.POLY_1271,
    funderAddress: depositWalletAddress,
    builderConfig: { builderCode: config.builderCode },
  });
}

async function connectWallet(): Promise<void> {
  if (!window.ethereum) {
    throw new Error("No EVM wallet detected. Use MetaMask, Rabby, or Phantom EVM.");
  }
  const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
  await ensurePolygonNetwork();
  ownerAddress = accounts[0];
  walletClient = createWalletClient({
    account: ownerAddress as `0x${string}`,
    chain: polygon,
    transport: custom(window.ethereum),
  });
  log("Connected browser-local owner signer", { ownerAddressHash: await sha256(ownerAddress) });
  deriveButton.disabled = false;
}

async function deriveDepositWallet(): Promise<void> {
  await ensurePolygonNetwork();
  await setupClients();
  depositWalletAddress = await relayer.deriveDepositWalletAddress();
  await setupClients();
  log("Derived deposit wallet", {
    depositWalletHash: await sha256(depositWalletAddress),
    ownerAddressHash: await sha256(ownerAddress),
  });
  signButton.disabled = false;
  deployButton.disabled = false;
}

async function signNoSubmitOrder(): Promise<void> {
  if (!depositWalletAddress) {
    throw new Error("Derive deposit wallet first.");
  }
  await ensurePolygonNetwork();
  const markets = await clob.getSimplifiedMarkets();
  const market = markets?.data?.find((entry: any) => Array.isArray(entry.tokens) && entry.tokens.length > 0) ?? markets?.data?.[0];
  const tokenId = market?.tokens?.[0]?.token_id || market?.tokens?.[0]?.tokenID || market?.clobTokenIds?.[0];
  if (!tokenId) {
    throw new Error("Could not find a token id from CLOB simplified markets.");
  }
  const book = await clob.getOrderBook(tokenId);
  const signed = await clob.createOrder({
    tokenID: tokenId,
    price: 0.5,
    size: Math.max(Number(book.min_order_size || 5), 5),
    side: Side.BUY,
    builderCode: config.builderCode,
  }, {
    tickSize: (book.tick_size || "0.01") as any,
    negRisk: Boolean(book.neg_risk),
  });

  const raw = JSON.parse(JSON.stringify(signed));
  const orderBody = raw.order && typeof raw.order === "object" ? raw.order : raw;
  const { redacted, signaturePresent } = await redactSignedOrder(signed);
  const mismatches: string[] = [];
  if (Number(orderBody.signatureType) !== SignatureTypeV2.POLY_1271) {
    mismatches.push(`signatureType ${orderBody.signatureType} != POLY_1271 ${SignatureTypeV2.POLY_1271}`);
  }
  if (String(orderBody.maker).toLowerCase() !== depositWalletAddress.toLowerCase()) {
    mismatches.push("maker is not deposit wallet");
  }
  if (String(orderBody.signer).toLowerCase() !== depositWalletAddress.toLowerCase()) {
    mismatches.push("signer is not deposit wallet");
  }
  if (String(orderBody.builder).toLowerCase() !== config.builderCode.toLowerCase()) {
    mismatches.push("builder code missing or changed");
  }

  const snapshot = {
    ok: mismatches.length === 0,
    probe: "browser-local-poly1271-sign-only",
    noOrderPosted: true,
    noPusdTransfer: true,
    ownerSignerSource: config.ownerSignerSource,
    ownerAddressHash: await sha256(ownerAddress),
    depositWalletHash: await sha256(depositWalletAddress),
    orderFields: {
      makerPresent: Boolean(orderBody.maker),
      signerPresent: Boolean(orderBody.signer),
      tokenIdPresent: Boolean(orderBody.tokenId || orderBody.tokenID),
      signatureType: Number(orderBody.signatureType),
      builder: orderBody.builder ?? null,
      metadataPresent: Boolean(orderBody.metadata),
      signatureHashPresent: signaturePresent,
    },
    sanitizedSignedOrder: redacted,
    mismatches,
  };
  const snapshotPath = await saveSnapshot(snapshot);
  log(mismatches.length === 0 ? "POLY_1271 no-submit fixture saved" : "POLY_1271 fixture mismatch", {
    snapshotPath,
    mismatches,
  });
}

async function deployDepositWallet(): Promise<void> {
  await ensurePolygonNetwork();
  const confirmed = window.confirm("This submits a relayer WALLET-CREATE request for the connected owner signer. It should not move user funds. Continue?");
  if (!confirmed) {
    log("Deposit wallet deployment canceled by user");
    return;
  }
  const response = await relayer.deployDepositWallet();
  const result = await response.wait();
  const snapshot = {
    ok: Boolean(result),
    probe: "browser-local-wallet-create",
    noPusdTransfer: true,
    ownerAddressHash: await sha256(ownerAddress),
    depositWalletHash: await sha256(depositWalletAddress),
    relayerResult: result ? {
      transactionHashPresent: Boolean((result as any).transactionHash),
      proxyAddressHash: (result as any).proxyAddress ? await sha256((result as any).proxyAddress) : null,
    } : null,
  };
  const snapshotPath = await saveSnapshot(snapshot);
  log("Deposit wallet deployment result saved", { snapshotPath, ok: snapshot.ok });
}

async function main(): Promise<void> {
  config = await fetch("/phase0-config").then((response) => response.json());
  log("Loaded Phase 0 browser config", {
    relayerUrl: config.relayerUrl,
    clobApiUrl: config.clobApiUrl,
    ownerSignerSource: config.ownerSignerSource,
    expectedSignatureType: config.expectedSignatureType,
  });
}

connectButton.addEventListener("click", () => void connectWallet().catch((error) => log("Connect failed", String(error))));
deriveButton.addEventListener("click", () => void deriveDepositWallet().catch((error) => log("Derive failed", String(error))));
signButton.addEventListener("click", () => void signNoSubmitOrder().catch((error) => log("Sign fixture failed", String(error))));
deployButton.addEventListener("click", () => void deployDepositWallet().catch((error) => log("Deploy failed", String(error))));

void main().catch((error) => log("Harness failed", String(error)));
