import React, { useEffect, useMemo, useState } from 'react';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { PublicKey, Transaction } from '@solana/web3.js';
import {
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { PDXDarkClient } from '../lib/pdx-dark';
import { PDX_PROGRAM_ID, USDC_MINT } from '../constants/protocol';
import { useProgramState } from '../hooks/useProgramState';
import { ShopWizard, ShopWizardPublishInput } from './ShopWizard';
import { SpendLedger } from './SpendLedger';
import { appendSpendLedger, readSpendLedger, SpendLedgerEntry } from '../lib/ledger';
import './PrivacyWallet.css';

interface PrivacyWalletProps {
  nullBalance: number;
  onBalanceUpdate: () => void;
  disabled: boolean;
}

type SettlementMode = 'transfer' | 'stream' | 'netting';

interface QuoteResponse {
  quoteId: string;
  totalAtomic: string;
  amount: string;
  mint: string;
  recipient: string;
  settlement: SettlementMode[];
}

interface PaymentAccept {
  mode: SettlementMode;
}

interface PaymentRequirements {
  quote: QuoteResponse;
  accepts: PaymentAccept[];
  recommendedMode: SettlementMode;
  commitEndpoint: string;
  finalizeEndpoint: string;
  receiptEndpoint: string;
}

interface SignedReceipt {
  payload: {
    receiptId: string;
  };
  prevHash: string;
  receiptHash: string;
  signerPublicKey: string;
  signature: string;
}

interface UsageLogEntry {
  toolId: string;
  amountAtomic: string;
  timestampMs: number;
}

interface ToolPrice {
  toolId: string;
  label: string;
  amountAtomic: string;
  tier: 'flat' | 'surge' | 'stream';
  weight: number;
}

interface BudgetEstimate {
  callsRemainingAtTypicalMix: number;
  minCallsAtCheapestTools: number;
  maxCallsAtPremiumTools: number;
  last7dProjectedSpend: string;
  basedOnRecentMix: boolean;
}

interface StreamSession {
  streamId: string;
  rateAtomicPerSecond: string;
  fundedUntilMs: number;
  status: 'active' | 'stopped';
  lastTopupSignature: string;
}

interface RankedMetric {
  key: string;
  value: number;
  meta?: Record<string, unknown>;
}

interface MarketQuote {
  quoteId: string;
  shopId: string;
  endpointId: string;
  method?: string;
  path: string;
  capabilityTags: string[];
  price: string;
  mint: string;
  expectedLatencyMs: number;
  rankScore: number;
  badges?: string[];
}

interface MarketSnapshot {
  topCapabilitiesByDemandVelocity: RankedMetric[];
  medianPriceByCapability: Record<string, string>;
  sellerDensityByCapability: Record<string, number>;
  volatilityScoreByCapability: Record<string, number>;
}

const USDC_DECIMALS = 6;
const DEFAULT_X402_BASE_URL = String(import.meta.env.VITE_X402_BASE_URL ?? 'http://localhost:8080').trim();
const AGENT_KEY_STORAGE_KEY = 'dnp_agent_key';
const USAGE_LOG_STORAGE_KEY = 'dnp_x402_usage_logs';
const SHOP_SIGNER_SECRET_STORAGE_KEY = 'dnp_shop_signer_secret_v1';

const TOOL_PRICES: ToolPrice[] = [
  { toolId: 'inference-fast', label: 'Fast Inference', amountAtomic: '5000', tier: 'surge', weight: 5 },
  { toolId: 'pdf-summarize', label: 'PDF Summarize', amountAtomic: '2500', tier: 'flat', weight: 3 },
  { toolId: 'stream-access', label: 'Streaming Access', amountAtomic: '600', tier: 'stream', weight: 1 },
];

function clampCalls(value: bigint): number {
  if (value <= 0n) {
    return 0;
  }
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    return Number.MAX_SAFE_INTEGER;
  }
  return Number(value);
}

function parseAtomic(value: string): bigint {
  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid atomic amount: ${value}`);
  }
  return BigInt(value);
}

function atomicToUi(amountAtomic: string, decimals = USDC_DECIMALS): number {
  return Number(amountAtomic) / 10 ** decimals;
}

function estimateBudget(balanceAtomic: string, tools: ToolPrice[], usageLogs: UsageLogEntry[]): BudgetEstimate {
  const balance = parseAtomic(balanceAtomic);
  if (tools.length === 0 || balance <= 0n) {
    return {
      callsRemainingAtTypicalMix: 0,
      minCallsAtCheapestTools: 0,
      maxCallsAtPremiumTools: 0,
      last7dProjectedSpend: '0',
      basedOnRecentMix: false,
    };
  }

  const sorted = [...tools].sort((a, b) => Number(parseAtomic(a.amountAtomic) - parseAtomic(b.amountAtomic)));
  const cheapest = parseAtomic(sorted[0].amountAtomic);
  const premium = parseAtomic(sorted[sorted.length - 1].amountAtomic);

  const nowMs = Date.now();
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  const recentLogs = usageLogs.filter((entry) => entry.timestampMs >= nowMs - sevenDaysMs);

  const logWeightsByTool = new Map<string, number>();
  for (const entry of recentLogs) {
    logWeightsByTool.set(entry.toolId, (logWeightsByTool.get(entry.toolId) ?? 0) + 1);
  }

  const basedOnRecentMix = logWeightsByTool.size > 0;
  const weightedAmount = tools.reduce((sum, tool) => {
    const weight = basedOnRecentMix ? (logWeightsByTool.get(tool.toolId) ?? 0) : tool.weight;
    if (weight <= 0) {
      return sum;
    }
    return sum + parseAtomic(tool.amountAtomic) * BigInt(weight);
  }, 0n);

  const totalWeight = tools.reduce((sum, tool) => {
    const weight = basedOnRecentMix ? (logWeightsByTool.get(tool.toolId) ?? 0) : tool.weight;
    return sum + BigInt(Math.max(0, weight));
  }, 0n);

  const typicalMixCost = totalWeight > 0n ? ((weightedAmount + totalWeight - 1n) / totalWeight) : parseAtomic(tools[0].amountAtomic);
  const last7dProjectedSpend = recentLogs.reduce((sum, entry) => sum + parseAtomic(entry.amountAtomic), 0n).toString(10);

  return {
    callsRemainingAtTypicalMix: clampCalls(balance / typicalMixCost),
    minCallsAtCheapestTools: clampCalls(balance / cheapest),
    maxCallsAtPremiumTools: clampCalls(balance / premium),
    last7dProjectedSpend,
    basedOnRecentMix,
  };
}

function readUsageLogs(): UsageLogEntry[] {
  try {
    const raw = localStorage.getItem(USAGE_LOG_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as UsageLogEntry[];
    return Array.isArray(parsed) ? parsed.slice(-500) : [];
  } catch {
    return [];
  }
}

function writeUsageLog(entry: UsageLogEntry): UsageLogEntry[] {
  const logs = [...readUsageLogs(), entry].slice(-500);
  localStorage.setItem(USAGE_LOG_STORAGE_KEY, JSON.stringify(logs));
  return logs;
}

function makeRandomHexCommitment(): string {
  const randomBytes = new Uint8Array(32);
  window.crypto.getRandomValues(randomBytes);
  return `0x${Array.from(randomBytes).map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

function hexToBytes(hex: string): Uint8Array {
  const normalized = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(normalized.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

async function sha256Hex(input: string): Promise<string> {
  const encoded = new TextEncoder().encode(input);
  const digest = await window.crypto.subtle.digest('SHA-256', encoded.buffer as ArrayBuffer);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function verifyReceiptSignature(receipt: SignedReceipt): Promise<boolean> {
  const computedHash = await sha256Hex(JSON.stringify({
    prevHash: receipt.prevHash,
    payload: receipt.payload,
  }));
  if (computedHash !== receipt.receiptHash) {
    return false;
  }

  const publicKey = bs58.decode(receipt.signerPublicKey);
  const signature = bs58.decode(receipt.signature);
  return nacl.sign.detached.verify(hexToBytes(receipt.receiptHash), signature, publicKey);
}

function resolveEndpoint(baseUrl: string, endpoint: string): string {
  if (endpoint.startsWith('http://') || endpoint.startsWith('https://')) {
    return endpoint;
  }
  return new URL(endpoint, `${baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`}`).toString();
}

function shortAddress(value: string): string {
  if (value.length <= 12) {
    return value;
  }
  return `${value.slice(0, 6)}...${value.slice(-6)}`;
}

function formatDateTime(ms: number): string {
  return new Date(ms).toLocaleString();
}

function demoResourceForCapability(capability?: string): string {
  if (!capability) {
    return '/resource';
  }
  if (capability.includes('inference')) {
    return '/inference';
  }
  if (capability.includes('stream')) {
    return '/stream-access';
  }
  return '/resource';
}

function formatMetricKey(key: string): string {
  return key.split('::').join(' / ');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

function randomHex(bytes = 4): string {
  const input = new Uint8Array(bytes);
  window.crypto.getRandomValues(input);
  return Array.from(input).map((value) => value.toString(16).padStart(2, '0')).join('');
}

function toShopId(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 28);
  return `${base || 'shop'}-${randomHex(3)}`;
}

export const PrivacyWallet: React.FC<PrivacyWalletProps> = ({
  nullBalance,
  onBalanceUpdate,
  disabled,
}) => {
  const { publicKey, sendTransaction, signTransaction, signMessage } = useWallet();
  const { connection } = useConnection();
  const { isPaused, loading: programLoading, error: programError } = useProgramState(connection, PDX_PROGRAM_ID);

  const [recipient, setRecipient] = useState('');
  const [asset, setAsset] = useState<'USDC' | 'NULL'>('USDC');
  const [amount, setAmount] = useState('');
  const [memo, setMemo] = useState('');
  const [loading, setLoading] = useState(false);

  const [usdcAta, setUsdcAta] = useState('');
  const [usdcAtaExists, setUsdcAtaExists] = useState(false);
  const [usdcBalanceAtomic, setUsdcBalanceAtomic] = useState('0');
  const [fundError, setFundError] = useState('');
  const [usageLogs, setUsageLogs] = useState<UsageLogEntry[]>([]);
  const [spendLedger, setSpendLedger] = useState<SpendLedgerEntry[]>([]);
  const [dailyBudgetAtomic, setDailyBudgetAtomic] = useState('2000000');

  const [agentKey, setAgentKey] = useState('');
  const [x402BaseUrl, setX402BaseUrl] = useState(DEFAULT_X402_BASE_URL);

  const [demoLoading, setDemoLoading] = useState(false);
  const [demoMessage, setDemoMessage] = useState('');
  const [demoReceiptId, setDemoReceiptId] = useState('');
  const [demoCommitId, setDemoCommitId] = useState('');
  const [demoReceiptVerified, setDemoReceiptVerified] = useState<boolean | null>(null);

  const [streamRecipient, setStreamRecipient] = useState('');
  const [streamRateAtomicPerSecond, setStreamRateAtomicPerSecond] = useState('100');
  const [streamTopupAtomic, setStreamTopupAtomic] = useState('10000');
  const [streamLoading, setStreamLoading] = useState(false);
  const [streamError, setStreamError] = useState('');
  const [streamSession, setStreamSession] = useState<StreamSession | null>(null);

  const [marketWindow, setMarketWindow] = useState<'1h' | '24h'>('24h');
  const [marketVerificationTier, setMarketVerificationTier] = useState<'FAST' | 'VERIFIED'>('FAST');
  const [marketCapability, setMarketCapability] = useState('inference');
  const [marketMaxPriceAtomic, setMarketMaxPriceAtomic] = useState('5000');
  const [marketMaxLatencyMs, setMarketMaxLatencyMs] = useState('2000');
  const [marketLoading, setMarketLoading] = useState(false);
  const [marketError, setMarketError] = useState('');
  const [marketTrending, setMarketTrending] = useState<RankedMetric[]>([]);
  const [marketOnSale, setMarketOnSale] = useState<RankedMetric[]>([]);
  const [marketTopSelling, setMarketTopSelling] = useState<RankedMetric[]>([]);
  const [marketTopRevenue, setMarketTopRevenue] = useState<RankedMetric[]>([]);
  const [marketQuotes, setMarketQuotes] = useState<MarketQuote[]>([]);
  const [marketSnapshot, setMarketSnapshot] = useState<MarketSnapshot | null>(null);

  const budgetEstimate = useMemo(() => estimateBudget(usdcBalanceAtomic, TOOL_PRICES, usageLogs), [usdcBalanceAtomic, usageLogs]);

  const pdxClient = useMemo(() => new PDXDarkClient(connection), [connection]);

  useEffect(() => {
    setUsageLogs(readUsageLogs());
    setSpendLedger(readSpendLedger());
    const savedKey = localStorage.getItem(AGENT_KEY_STORAGE_KEY);
    if (savedKey) {
      setAgentKey(savedKey);
    }
  }, []);

  useEffect(() => {
    if (!publicKey) {
      setUsdcAta('');
      setUsdcAtaExists(false);
      setUsdcBalanceAtomic('0');
      setFundError('');
      return;
    }

    const loadFundingState = async () => {
      try {
        setFundError('');
        const ata = getAssociatedTokenAddressSync(USDC_MINT, publicKey, false, TOKEN_PROGRAM_ID);
        setUsdcAta(ata.toBase58());

        const accountInfo = await connection.getAccountInfo(ata, 'confirmed');
        if (!accountInfo) {
          setUsdcAtaExists(false);
          setUsdcBalanceAtomic('0');
          return;
        }

        setUsdcAtaExists(true);
        const balance = await connection.getTokenAccountBalance(ata, 'confirmed');
        setUsdcBalanceAtomic(balance.value.amount);
      } catch (error) {
        setFundError(error instanceof Error ? error.message : 'Failed to load USDC funding state');
      }
    };

    loadFundingState().catch(() => {
      setFundError('Failed to load USDC funding state');
    });
  }, [connection, publicKey]);

  useEffect(() => {
    if (!streamRecipient && usdcAta) {
      setStreamRecipient(usdcAta);
    }
  }, [streamRecipient, usdcAta]);

  const createUsdcAta = async () => {
    if (!publicKey || !sendTransaction) {
      setFundError('Wallet must support sendTransaction to create USDC ATA');
      return;
    }

    try {
      setFundError('');
      const ata = getAssociatedTokenAddressSync(USDC_MINT, publicKey, false, TOKEN_PROGRAM_ID);

      const ix = createAssociatedTokenAccountInstruction(
        publicKey,
        ata,
        publicKey,
        USDC_MINT,
        TOKEN_PROGRAM_ID,
      );

      const tx = new Transaction().add(ix);
      tx.feePayer = publicKey;

      const signature = await sendTransaction(tx, connection, { skipPreflight: false, maxRetries: 3 });
      await connection.confirmTransaction(signature, 'confirmed');

      setUsdcAta(ata.toBase58());
      setUsdcAtaExists(true);
      const balance = await connection.getTokenAccountBalance(ata, 'confirmed').catch(() => null);
      setUsdcBalanceAtomic(balance?.value.amount ?? '0');
      onBalanceUpdate();
    } catch (error) {
      setFundError(error instanceof Error ? error.message : 'Failed to create USDC ATA');
    }
  };

  const handlePrivacyTransfer = async () => {
    if (!publicKey || !recipient || !amount) {
      return;
    }

    setLoading(true);
    try {
      const result = await pdxClient.transfer({
        asset,
        amount: Number.parseFloat(amount),
        recipient: new PublicKey(recipient),
        memo,
        useCompression: true,
        wallet: {
          publicKey,
          sendTransaction,
          signTransaction,
        },
      });

      setDemoMessage(`Transfer confirmed: ${result.signature}`);
      setAmount('');
      setMemo('');
      onBalanceUpdate();
    } catch (error) {
      setDemoMessage(error instanceof Error ? error.message : 'Privacy transfer failed');
    } finally {
      setLoading(false);
    }
  };

  const generateAgentKey = () => {
    const randomBytes = new Uint8Array(24);
    window.crypto.getRandomValues(randomBytes);
    const generated = bs58.encode(randomBytes);
    localStorage.setItem(AGENT_KEY_STORAGE_KEY, generated);
    setAgentKey(generated);
  };

  const copyText = async (value: string) => {
    await navigator.clipboard.writeText(value);
  };

  const recordSpend = (entry: Omit<SpendLedgerEntry, 'ts'>) => {
    const updated = appendSpendLedger(entry);
    setSpendLedger(updated);
  };

  const resolveFallbackShopSigner = () => {
    const existing = localStorage.getItem(SHOP_SIGNER_SECRET_STORAGE_KEY);
    if (existing) {
      try {
        const secretKey = bs58.decode(existing);
        if (secretKey.length === 64) {
          const keypair = nacl.sign.keyPair.fromSecretKey(secretKey);
          return {
            secretKey,
            ownerPubkey: bs58.encode(keypair.publicKey),
          };
        }
      } catch {
        // ignore malformed local key and rotate below
      }
    }

    const keypair = nacl.sign.keyPair();
    const encoded = bs58.encode(keypair.secretKey);
    localStorage.setItem(SHOP_SIGNER_SECRET_STORAGE_KEY, encoded);
    return {
      secretKey: keypair.secretKey,
      ownerPubkey: bs58.encode(keypair.publicKey),
    };
  };

  const signManifestHash = async (hashHex: string): Promise<{ ownerPubkey: string; signature: string }> => {
    const digest = hexToBytes(hashHex);
    if (publicKey && signMessage) {
      try {
        const walletSig = await signMessage(digest);
        return {
          ownerPubkey: publicKey.toBase58(),
          signature: bs58.encode(walletSig),
        };
      } catch {
        // Fall through to local signer in wallets without message-sign support.
      }
    }

    const fallback = resolveFallbackShopSigner();
    const localSig = nacl.sign.detached(digest, fallback.secretKey);
    return {
      ownerPubkey: fallback.ownerPubkey,
      signature: bs58.encode(localSig),
    };
  };

  const publishShopFromWizard = async (input: ShopWizardPublishInput) => {
    if (!x402BaseUrl) {
      throw new Error('Missing X402 base URL');
    }

    const provisionalOwner = publicKey?.toBase58() ?? resolveFallbackShopSigner().ownerPubkey;
    const manifest = {
      manifestVersion: 'market-v1' as const,
      shopId: toShopId(input.name),
      name: input.name,
      description: input.description,
      category: input.category,
      ownerPubkey: provisionalOwner,
      endpoints: input.endpoints,
    };

    const manifestHash = await sha256Hex(stableStringify(manifest));
    const signed = await signManifestHash(manifestHash);

    const finalizedManifest = {
      ...manifest,
      ownerPubkey: signed.ownerPubkey,
    };
    const finalizedManifestHash = await sha256Hex(stableStringify(finalizedManifest));
    const finalizedSignature = finalizedManifestHash === manifestHash
      ? signed.signature
      : (await signManifestHash(finalizedManifestHash)).signature;

    const response = await fetch(`${x402BaseUrl.replace(/\/$/, '')}/market/shops`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        manifest: finalizedManifest,
        manifestHash: finalizedManifestHash,
        signature: finalizedSignature,
        publishedAt: new Date().toISOString(),
      }),
    });

    if (!response.ok) {
      const bodyText = await response.text();
      throw new Error(`Publish failed (${response.status}) ${bodyText}`);
    }

    await fetchMarketInsights();
  };

  const runPaidDemo = async (resourcePath = '/resource') => {
    if (!publicKey) {
      setDemoMessage('Connect wallet first');
      return;
    }

    if (!x402BaseUrl) {
      setDemoMessage('Missing X402 base URL');
      return;
    }

    setDemoLoading(true);
    setDemoMessage('Running 402 flow...');
    setDemoReceiptVerified(null);

    try {
      const resource = resourcePath.startsWith('/') ? resourcePath : `/${resourcePath}`;
      const first = await fetch(`${x402BaseUrl}${resource}`);
      if (first.status !== 402) {
        throw new Error(`Expected 402 but got ${first.status}`);
      }

      const firstPayload = await first.json() as { paymentRequirements?: PaymentRequirements };
      const requirements = firstPayload.paymentRequirements;
      if (!requirements) {
        throw new Error('Missing payment requirements in 402 response');
      }

      const commitRes = await fetch(resolveEndpoint(x402BaseUrl, requirements.commitEndpoint), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          quoteId: requirements.quote.quoteId,
          payerCommitment32B: makeRandomHexCommitment(),
        }),
      });

      if (!commitRes.ok) {
        throw new Error(`Commit failed with status ${commitRes.status}`);
      }

      const commitData = await commitRes.json() as { commitId: string };
      setDemoCommitId(commitData.commitId);

      const transferResult = await pdxClient.transfer({
        asset: 'USDC',
        amount: atomicToUi(requirements.quote.totalAtomic),
        recipient: new PublicKey(requirements.quote.recipient),
        memo: `x402-demo-${requirements.quote.quoteId}`,
        useCompression: true,
        wallet: {
          publicKey,
          sendTransaction,
          signTransaction,
        },
      });

      const finalizeRes = await fetch(resolveEndpoint(x402BaseUrl, requirements.finalizeEndpoint), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          commitId: commitData.commitId,
          paymentProof: {
            settlement: 'transfer',
            txSignature: transferResult.signature,
            amountAtomic: requirements.quote.totalAtomic,
          },
        }),
      });

      if (!finalizeRes.ok) {
        throw new Error(`Finalize failed with status ${finalizeRes.status}`);
      }

      const finalizeData = await finalizeRes.json() as { receiptId: string };
      setDemoReceiptId(finalizeData.receiptId);

      const receiptRes = await fetch(resolveEndpoint(
        x402BaseUrl,
        requirements.receiptEndpoint.replace(':receiptId', finalizeData.receiptId),
      ));
      if (!receiptRes.ok) {
        throw new Error(`Receipt fetch failed with status ${receiptRes.status}`);
      }
      const receipt = await receiptRes.json() as SignedReceipt;
      const verified = await verifyReceiptSignature(receipt);
      setDemoReceiptVerified(verified);

      const paidRetry = await fetch(`${x402BaseUrl}${resource}`, {
        headers: {
          'x-dnp-commit-id': commitData.commitId,
        },
      });

      if (paidRetry.status !== 200) {
        throw new Error(`Paid retry returned ${paidRetry.status}`);
      }

      const refreshedLogs = writeUsageLog({
        toolId: resource === '/inference' ? 'inference-fast' : resource === '/stream-access' ? 'stream-access' : 'pdf-summarize',
        amountAtomic: requirements.quote.totalAtomic,
        timestampMs: Date.now(),
      });
      setUsageLogs(refreshedLogs);
      recordSpend({
        shopId: 'dnp-core',
        endpointId: resource.replace(/^\//, '') || 'resource',
        capability: resource.replace(/^\//, '') || 'resource',
        amountAtomic: requirements.quote.totalAtomic,
        mode: 'transfer',
        receiptId: finalizeData.receiptId,
      });

      setDemoMessage(`402 -> pay -> retry complete for ${resource}. Receipt saved and verified.`);
      onBalanceUpdate();
    } catch (error) {
      setDemoMessage(error instanceof Error ? error.message : 'Demo failed');
      setDemoReceiptVerified(false);
    } finally {
      setDemoLoading(false);
    }
  };

  const fetchMarketInsights = async () => {
    setMarketLoading(true);
    setMarketError('');
    try {
      const rankedQuery = new URLSearchParams({
        window: marketWindow,
        verificationTier: marketVerificationTier,
      }).toString();
      const [trendingRes, onSaleRes, topSellingRes, topRevenueRes, snapshotRes] = await Promise.all([
        fetch(`${x402BaseUrl}/market/trending?${rankedQuery}`),
        fetch(`${x402BaseUrl}/market/on-sale?window=24h`),
        fetch(`${x402BaseUrl}/market/top-selling?${rankedQuery}`),
        fetch(`${x402BaseUrl}/market/top-revenue?${rankedQuery}`),
        fetch(`${x402BaseUrl}/market/snapshot`),
      ]);

      if (!trendingRes.ok || !onSaleRes.ok || !topSellingRes.ok || !topRevenueRes.ok || !snapshotRes.ok) {
        throw new Error('Market endpoints unavailable');
      }

      const trending = await trendingRes.json() as { results: RankedMetric[] };
      const onSale = await onSaleRes.json() as { results: RankedMetric[] };
      const topSelling = await topSellingRes.json() as { results: RankedMetric[] };
      const topRevenue = await topRevenueRes.json() as { results: RankedMetric[] };
      const snapshot = await snapshotRes.json() as MarketSnapshot;

      setMarketTrending(trending.results.slice(0, 5));
      setMarketOnSale(onSale.results.slice(0, 5));
      setMarketTopSelling(topSelling.results.slice(0, 5));
      setMarketTopRevenue(topRevenue.results.slice(0, 5));
      setMarketSnapshot(snapshot);
    } catch (error) {
      setMarketError(error instanceof Error ? error.message : 'Failed to load market insights');
    } finally {
      setMarketLoading(false);
    }
  };

  const fetchMarketQuotes = async () => {
    setMarketLoading(true);
    setMarketError('');
    try {
      const query = new URLSearchParams({
        capability: marketCapability,
        maxPrice: marketMaxPriceAtomic,
        maxLatencyMs: marketMaxLatencyMs,
        limit: '10',
      });
      const response = await fetch(`${x402BaseUrl}/market/quotes?${query.toString()}`);
      if (!response.ok) {
        throw new Error(`Quote lookup failed (${response.status})`);
      }
      const payload = await response.json() as { quotes: MarketQuote[] };
      setMarketQuotes(payload.quotes.slice(0, 10));
    } catch (error) {
      setMarketError(error instanceof Error ? error.message : 'Failed to fetch market quotes');
    } finally {
      setMarketLoading(false);
    }
  };

  const runQuoteDemo = async (quote: MarketQuote) => {
    const capability = quote.capabilityTags[0];
    const quotePath = quote.path.startsWith('/') ? quote.path : `/${quote.path}`;
    try {
      const probe = await fetch(`${x402BaseUrl}${quotePath}`);
      if (probe.status === 402 || probe.status === 200) {
        await runPaidDemo(quotePath);
        return;
      }
    } catch {
      // Fall back to core capability mapping.
    }
    await runPaidDemo(demoResourceForCapability(capability));
  };

  useEffect(() => {
    fetchMarketInsights().catch(() => {
      setMarketError('Failed to load market insights');
    });
  }, [x402BaseUrl, marketWindow, marketVerificationTier]);

  const runStreamTransfer = async (target: string, topupAtomic: string): Promise<string> => {
    if (!publicKey) {
      throw new Error('Connect wallet first');
    }
    if (!/^\d+$/.test(topupAtomic)) {
      throw new Error('Top-up amount must be atomic integer');
    }
    const tx = await pdxClient.transfer({
      asset: 'USDC',
      amount: atomicToUi(topupAtomic),
      recipient: new PublicKey(target),
      memo: 'stream-topup',
      useCompression: true,
      wallet: {
        publicKey,
        sendTransaction,
        signTransaction,
      },
    });
    return tx.signature;
  };

  const openStream = async () => {
    setStreamLoading(true);
    setStreamError('');
    try {
      if (!streamRecipient) {
        throw new Error('Provide stream recipient');
      }
      const rate = parseAtomic(streamRateAtomicPerSecond);
      if (rate <= 0n) {
        throw new Error('Rate must be > 0');
      }
      const topup = parseAtomic(streamTopupAtomic);
      const signature = await runStreamTransfer(streamRecipient, streamTopupAtomic);
      const durationSeconds = Number(topup / rate);
      const fundedUntilMs = Date.now() + Math.max(1, durationSeconds) * 1000;

      setStreamSession({
        streamId: `stream-${Date.now().toString(36)}`,
        rateAtomicPerSecond: streamRateAtomicPerSecond,
        fundedUntilMs,
        status: 'active',
        lastTopupSignature: signature,
      });

      const refreshedLogs = writeUsageLog({
        toolId: 'stream-access',
        amountAtomic: streamTopupAtomic,
        timestampMs: Date.now(),
      });
      setUsageLogs(refreshedLogs);
      recordSpend({
        shopId: 'dnp-core',
        endpointId: 'stream-access',
        capability: 'stream_access',
        amountAtomic: streamTopupAtomic,
        mode: 'stream',
        receiptId: signature,
      });
    } catch (error) {
      setStreamError(error instanceof Error ? error.message : 'Failed to open stream');
    } finally {
      setStreamLoading(false);
    }
  };

  const topupStream = async () => {
    if (!streamSession || streamSession.status !== 'active') {
      setStreamError('Open an active stream first');
      return;
    }

    setStreamLoading(true);
    setStreamError('');
    try {
      const rate = parseAtomic(streamSession.rateAtomicPerSecond);
      const topup = parseAtomic(streamTopupAtomic);
      const signature = await runStreamTransfer(streamRecipient, streamTopupAtomic);
      const durationSeconds = Number(topup / rate);
      const baseMs = streamSession.fundedUntilMs > Date.now() ? streamSession.fundedUntilMs : Date.now();

      setStreamSession({
        ...streamSession,
        fundedUntilMs: baseMs + Math.max(1, durationSeconds) * 1000,
        lastTopupSignature: signature,
      });

      const refreshedLogs = writeUsageLog({
        toolId: 'stream-access',
        amountAtomic: streamTopupAtomic,
        timestampMs: Date.now(),
      });
      setUsageLogs(refreshedLogs);
      recordSpend({
        shopId: 'dnp-core',
        endpointId: 'stream-access',
        capability: 'stream_access',
        amountAtomic: streamTopupAtomic,
        mode: 'stream',
        receiptId: signature,
      });
    } catch (error) {
      setStreamError(error instanceof Error ? error.message : 'Failed to top up stream');
    } finally {
      setStreamLoading(false);
    }
  };

  const stopStream = async () => {
    if (!streamSession) {
      return;
    }
    setStreamSession({
      ...streamSession,
      status: 'stopped',
      fundedUntilMs: Date.now(),
    });
  };

  const agentSnippet = `X402_BASE_URL=${x402BaseUrl}\nAGENT_KEY=${agentKey || '<generate-key>'}\n\nimport { fetchWith402 } from 'dnp-x402';\n\nawait fetchWith402(\`${x402BaseUrl}/inference\`, {\n  wallet,\n  maxSpendAtomic: '1000000',\n  preferStream: true,\n});`;
  const marketSnippet = `const quotes = await fetch('${x402BaseUrl}/market/quotes?capability=${marketCapability}&maxPrice=${marketMaxPriceAtomic}&maxLatencyMs=${marketMaxLatencyMs}&limit=5').then((r) => r.json());\nconst best = quotes.quotes?.[0];\nawait fetchWith402('${x402BaseUrl}${demoResourceForCapability(marketCapability)}', {\n  wallet,\n  maxSpendAtomic: '${marketMaxPriceAtomic}',\n  preferStream: true,\n});`;

  return (
    <div className="privacy-wallet">
      <h2>x402 Agent Wallet</h2>

      {disabled && (
        <div className="insufficient-funds">
          Privacy mode uses $NULL burn for legacy path. Current balance: {nullBalance.toFixed(2)} $NULL.
        </div>
      )}

      {programLoading ? (
        <div className="system-status loading">Checking program status...</div>
      ) : isPaused ? (
        <div className="system-status paused">
          System paused. Payments disabled until program is resumed.
          {programError ? <small className="error-details">{programError}</small> : null}
        </div>
      ) : null}

      <section className="wallet-panel">
        <h3>Fund Agent (USDC)</h3>
        <div className="panel-grid">
          <div>
            <div className="metric-row">
              <span>USDC Balance</span>
              <strong>{atomicToUi(usdcBalanceAtomic).toFixed(6)} USDC</strong>
            </div>
            <div className="metric-row">
              <span>ATA</span>
              <code>{usdcAta ? shortAddress(usdcAta) : 'Not available'}</code>
            </div>
            <div className="metric-row">
              <span>Status</span>
              <strong>{usdcAtaExists ? 'Ready' : 'ATA missing'}</strong>
            </div>
            {fundError ? <div className="panel-error">{fundError}</div> : null}
            {!usdcAtaExists ? (
              <button className="panel-button" onClick={createUsdcAta}>
                Create ATA
              </button>
            ) : null}
            {usdcAta ? (
              <button className="panel-button secondary" onClick={() => copyText(usdcAta)}>
                Copy Deposit Address
              </button>
            ) : null}
          </div>

          <div className="fund-qr-wrap">
            {usdcAta ? (
              <img
                className="fund-qr"
                src={`https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(usdcAta)}`}
                alt="USDC ATA QR"
              />
            ) : (
              <div className="fund-qr-placeholder">Connect wallet to show deposit QR</div>
            )}
          </div>
        </div>
      </section>

      <section className="wallet-panel">
        <h3>Catalog-Aware Budget</h3>
        <div className="metric-row">
          <span>Calls at typical mix</span>
          <strong>{budgetEstimate.callsRemainingAtTypicalMix}</strong>
        </div>
        <div className="metric-row">
          <span>Min calls (cheapest tools)</span>
          <strong>{budgetEstimate.minCallsAtCheapestTools}</strong>
        </div>
        <div className="metric-row">
          <span>Max calls (premium tools)</span>
          <strong>{budgetEstimate.maxCallsAtPremiumTools}</strong>
        </div>
        <div className="metric-row">
          <span>Projected last 7d spend</span>
          <strong>{atomicToUi(budgetEstimate.last7dProjectedSpend).toFixed(6)} USDC</strong>
        </div>
        <p className="panel-note">
          {budgetEstimate.basedOnRecentMix ? 'Based on your recent mix.' : 'Based on default typical tool mix.'}
        </p>
      </section>

      <section className="wallet-panel">
        <h3>Get Agent Key</h3>
        <div className="form-group">
          <label>X402 Base URL</label>
          <input value={x402BaseUrl} onChange={(e) => setX402BaseUrl(e.target.value)} placeholder="http://localhost:8080" />
        </div>
        <div className="form-group">
          <label>Agent Key</label>
          <input value={agentKey} readOnly placeholder="Generate agent key" />
        </div>
        <div className="button-row">
          <button className="panel-button" onClick={generateAgentKey}>Generate Agent Key</button>
          <button className="panel-button secondary" onClick={() => copyText(agentSnippet)}>Copy Snippet</button>
        </div>
        <textarea className="snippet-box" value={agentSnippet} readOnly />
      </section>

      <section className="wallet-panel">
        <h3>One-Click Demo</h3>
        <button className="panel-button" onClick={() => runPaidDemo()} disabled={demoLoading || isPaused}>
          {demoLoading ? 'Running demo...' : 'Try It'}
        </button>
        {demoMessage ? <p className="panel-note">{demoMessage}</p> : null}
        {demoCommitId ? <p className="demo-detail"><strong>Commit:</strong> <code>{demoCommitId}</code></p> : null}
        {demoReceiptId ? <p className="demo-detail"><strong>Receipt:</strong> <code>{demoReceiptId}</code></p> : null}
        {demoReceiptVerified !== null ? (
          <p className={`demo-detail ${demoReceiptVerified ? 'ok' : 'bad'}`}>
            Receipt verification: {demoReceiptVerified ? 'valid signature' : 'invalid signature'}
          </p>
        ) : null}
      </section>

      <section className="wallet-panel">
        <h3>Create Shop Wizard</h3>
        <ShopWizard
          x402BaseUrl={x402BaseUrl}
          disabled={isPaused}
          onPublish={publishShopFromWizard}
          onPublished={() => {
            fetchMarketInsights().catch(() => undefined);
            fetchMarketQuotes().catch(() => undefined);
          }}
        />
      </section>

      <section className="wallet-panel">
        <h3>Vault Spend Ledger</h3>
        <div className="form-group">
          <label>Daily budget cap (atomic)</label>
          <input value={dailyBudgetAtomic} onChange={(e) => setDailyBudgetAtomic(e.target.value)} placeholder="2000000" />
        </div>
        <SpendLedger entries={spendLedger} dailyBudgetAtomic={dailyBudgetAtomic} />
      </section>

      <section className="wallet-panel">
        <h3>Marketplace Intelligence</h3>
        <div className="market-controls">
          <div className="form-group">
            <label>Window</label>
            <select value={marketWindow} onChange={(e) => setMarketWindow(e.target.value as '1h' | '24h')}>
              <option value="1h">1h</option>
              <option value="24h">24h</option>
            </select>
          </div>
          <div className="form-group">
            <label>Leaderboard Tier</label>
            <select value={marketVerificationTier} onChange={(e) => setMarketVerificationTier(e.target.value as 'FAST' | 'VERIFIED')}>
              <option value="FAST">Fast</option>
              <option value="VERIFIED">Verified</option>
            </select>
          </div>
          <div className="form-group">
            <label>Capability</label>
            <input value={marketCapability} onChange={(e) => setMarketCapability(e.target.value)} placeholder="inference" />
          </div>
          <div className="form-group">
            <label>Max Price (atomic)</label>
            <input value={marketMaxPriceAtomic} onChange={(e) => setMarketMaxPriceAtomic(e.target.value)} />
          </div>
          <div className="form-group">
            <label>Max Latency (ms)</label>
            <input value={marketMaxLatencyMs} onChange={(e) => setMarketMaxLatencyMs(e.target.value)} />
          </div>
        </div>

        <div className="button-row">
          <button className="panel-button" onClick={fetchMarketInsights} disabled={marketLoading}>Refresh Market</button>
          <button className="panel-button secondary" onClick={fetchMarketQuotes} disabled={marketLoading}>Find Quotes</button>
          <button className="panel-button secondary" onClick={() => copyText(marketSnippet)}>Copy Agent Query Snippet</button>
        </div>

        {marketError ? <div className="panel-error">{marketError}</div> : null}

        <div className="market-grid">
          <div className="market-card">
            <h4>Trending</h4>
            {marketTrending.map((row) => (
              <div className="metric-row" key={`trending-${row.key}`}>
                <span>{formatMetricKey(row.key)}</span>
                <strong>{row.value.toFixed(3)}</strong>
              </div>
            ))}
            {marketTrending.length === 0 ? <p className="panel-note">No trending rows yet.</p> : null}
          </div>

          <div className="market-card">
            <h4>On Sale</h4>
            {marketOnSale.map((row) => (
              <div className="metric-row" key={`sale-${row.key}`}>
                <span>{formatMetricKey(row.key)}</span>
                <strong>{(row.value * 100).toFixed(1)}% drop</strong>
              </div>
            ))}
            {marketOnSale.length === 0 ? <p className="panel-note">No price drops detected.</p> : null}
          </div>

          <div className="market-card">
            <h4>Top Selling</h4>
            {marketTopSelling.map((row) => (
              <div className="metric-row" key={`selling-${row.key}`}>
                <span>{formatMetricKey(row.key)}</span>
                <strong>{row.value.toFixed(0)} fills</strong>
              </div>
            ))}
            {marketTopSelling.length === 0 ? <p className="panel-note">No sales yet.</p> : null}
          </div>

          <div className="market-card">
            <h4>Top Revenue</h4>
            {marketTopRevenue.map((row) => (
              <div className="metric-row" key={`revenue-${row.key}`}>
                <span>{formatMetricKey(row.key)}</span>
                <strong>{atomicToUi(Math.round(row.value).toString()).toFixed(6)} USDC</strong>
              </div>
            ))}
            {marketTopRevenue.length === 0 ? <p className="panel-note">No revenue rows yet.</p> : null}
          </div>
        </div>

        {marketSnapshot ? (
          <div className="snapshot-wrap">
            <h4>Snapshot</h4>
            <div className="metric-row">
              <span>Demand leaders</span>
              <strong>{marketSnapshot.topCapabilitiesByDemandVelocity.slice(0, 3).map((entry) => entry.key).join(', ') || 'n/a'}</strong>
            </div>
            <div className="metric-row">
              <span>Seller density</span>
              <strong>{Object.entries(marketSnapshot.sellerDensityByCapability).map(([cap, n]) => `${cap}:${n}`).join(' | ') || 'n/a'}</strong>
            </div>
          </div>
        ) : null}

        <div className="quote-list">
          <h4>Competing Quotes</h4>
          {marketQuotes.map((quote) => (
            <div className="quote-row" key={quote.quoteId}>
              <div>
                <strong>{quote.shopId}</strong>
                <div className="panel-note">{quote.endpointId} · {quote.capabilityTags.join(', ')}</div>
                {quote.badges && quote.badges.length > 0 ? (
                  <div className="quote-badges">{quote.badges.join(' · ')}</div>
                ) : null}
              </div>
              <div className="quote-metrics">
                <span>{atomicToUi(quote.price).toFixed(6)} {quote.mint}</span>
                <span>{quote.expectedLatencyMs}ms</span>
                <span>{quote.rankScore.toFixed(3)}</span>
              </div>
              <button className="panel-button secondary" onClick={() => runQuoteDemo(quote)} disabled={demoLoading || isPaused}>
                Use This Quote
              </button>
            </div>
          ))}
          {marketQuotes.length === 0 ? <p className="panel-note">Run “Find Quotes” to discover market offers.</p> : null}
        </div>
      </section>

      <section className="wallet-panel">
        <h3>Stream Management</h3>
        <div className="form-group">
          <label>Recipient</label>
          <input value={streamRecipient} onChange={(e) => setStreamRecipient(e.target.value)} placeholder="Recipient address" />
        </div>
        <div className="form-group">
          <label>Rate (atomic/sec)</label>
          <input value={streamRateAtomicPerSecond} onChange={(e) => setStreamRateAtomicPerSecond(e.target.value)} />
        </div>
        <div className="form-group">
          <label>Top-up amount (atomic)</label>
          <input value={streamTopupAtomic} onChange={(e) => setStreamTopupAtomic(e.target.value)} />
        </div>

        <div className="button-row">
          <button className="panel-button" onClick={openStream} disabled={streamLoading || isPaused}>Open Stream</button>
          <button className="panel-button" onClick={topupStream} disabled={streamLoading || !streamSession || streamSession.status !== 'active'}>Top Up</button>
          <button className="panel-button secondary" onClick={stopStream} disabled={!streamSession || streamSession.status !== 'active'}>Stop</button>
        </div>

        {streamError ? <div className="panel-error">{streamError}</div> : null}
        {streamSession ? (
          <div className="stream-state">
            <div className="metric-row"><span>Stream ID</span><code>{streamSession.streamId}</code></div>
            <div className="metric-row"><span>Rate</span><strong>{streamSession.rateAtomicPerSecond} atomic/s</strong></div>
            <div className="metric-row"><span>Funded Until</span><strong>{formatDateTime(streamSession.fundedUntilMs)}</strong></div>
            <div className="metric-row"><span>Status</span><strong>{streamSession.status}</strong></div>
            <div className="metric-row"><span>Last Top Up Tx</span><code>{shortAddress(streamSession.lastTopupSignature)}</code></div>
          </div>
        ) : null}
      </section>

      <section className="wallet-panel">
        <h3>Manual Payment</h3>
        <div className="form-group">
          <label>Asset</label>
          <select value={asset} onChange={(e) => setAsset(e.target.value as 'USDC' | 'NULL')}>
            <option value="USDC">USDC</option>
            <option value="NULL">NULL</option>
          </select>
        </div>
        <div className="form-group">
          <label>Recipient Address</label>
          <input value={recipient} onChange={(e) => setRecipient(e.target.value)} placeholder="Recipient" />
        </div>
        <div className="form-group">
          <label>Amount</label>
          <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.000001" />
        </div>
        <div className="form-group">
          <label>Memo</label>
          <textarea value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="Optional memo" />
        </div>
        <button className="privacy-send-button" onClick={handlePrivacyTransfer} disabled={loading || !recipient || !amount || isPaused}>
          {loading ? 'Sending...' : 'Send Transfer'}
        </button>
      </section>
    </div>
  );
};
