import crypto from "node:crypto";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { DbClient } from "../db/connection.js";
import { PaymentVerifier } from "../paymentVerifier.js";
import { PaymentProof, Quote } from "../types.js";

export type TipLedgerEventType =
  | "account_created"
  | "deposit_intent_created"
  | "deposit_confirmed"
  | "tip_sent"
  | "tip_received"
  | "withdrawal_requested"
  | "admin_adjustment"
  | "reconciliation";

export interface NullTipLedgerConfig {
  tokenMint: string;
  vaultAddress?: string;
  tokenSymbol: string;
  decimals: number;
  maxSendAtomic?: string;
  maxWithdrawAtomic?: string;
  sessionSecret?: string;
  sessionTtlSeconds: number;
  depositIntentTtlSeconds: number;
}

export interface TipAccount {
  ownerWallet: string;
  tokenMint: string;
  balanceAtomic: string;
  pendingWithdrawalAtomic: string;
  totalDepositedAtomic: string;
  totalSentAtomic: string;
  totalReceivedAtomic: string;
  totalWithdrawnAtomic: string;
  createdAt: string;
  updatedAt: string;
}

export interface TipLedgerRecord {
  id: string;
  eventType: TipLedgerEventType;
  ownerWallet: string;
  counterpartyWallet?: string;
  amountAtomic: string;
  tokenMint: string;
  status: string;
  txSignature?: string;
  depositIntentId?: string;
  withdrawalId?: string;
  transferId?: string;
  memo?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface TipDepositIntent {
  intentId: string;
  ownerWallet: string;
  amountAtomic?: string;
  tokenMint: string;
  vaultAddress?: string;
  memo: string;
  status: "PENDING" | "CONFIRMED" | "EXPIRED";
  txSignature?: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface TipSessionChallenge {
  challengeId: string;
  ownerWallet: string;
  message: string;
  expiresAt: string;
}

export interface TipSessionClaims {
  ownerWallet: string;
  scope: "null_tips";
  iat: number;
  exp: number;
}

export class TipLedgerError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

const DEFAULT_TOKEN_MINT = "NULL_MINT_NOT_CONFIGURED";
const DEFAULT_TOKEN_SYMBOL = "NULL";
const DEFAULT_DECIMALS = 6;
const ZERO = "0";

function nowIso(now: () => Date): string {
  return now().toISOString();
}

function uuid(): string {
  return crypto.randomUUID();
}

function assertAtomic(value: string, field = "amountAtomic"): bigint {
  if (!/^\d+$/.test(value)) {
    throw new TipLedgerError("TIP_INVALID_AMOUNT", `${field} must be a raw unsigned integer amount.`);
  }
  const amount = BigInt(value);
  if (amount <= 0n) {
    throw new TipLedgerError("TIP_INVALID_AMOUNT", `${field} must be greater than zero.`);
  }
  return amount;
}

function addAtomic(left: string, right: string): string {
  return (BigInt(left) + BigInt(right)).toString(10);
}

function subAtomic(left: string, right: string): string {
  return (BigInt(left) - BigInt(right)).toString(10);
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function hmac(data: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(data).digest("base64url");
}

function timingSafeEqualString(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function sanitizeWallet(value: string, field = "wallet"): string {
  const normalized = value.trim();
  if (normalized.length < 32 || normalized.length > 64) {
    throw new TipLedgerError("TIP_INVALID_WALLET", `${field} must be a Solana-style public wallet address.`);
  }
  return normalized;
}

function mapAccountRow(row: Record<string, unknown>): TipAccount {
  return {
    ownerWallet: String(row.owner_wallet),
    tokenMint: String(row.token_mint),
    balanceAtomic: String(row.balance_atomic),
    pendingWithdrawalAtomic: String(row.pending_withdrawal_atomic),
    totalDepositedAtomic: String(row.total_deposited_atomic),
    totalSentAtomic: String(row.total_sent_atomic),
    totalReceivedAtomic: String(row.total_received_atomic),
    totalWithdrawnAtomic: String(row.total_withdrawn_atomic),
    createdAt: new Date(row.created_at as string | Date).toISOString(),
    updatedAt: new Date(row.updated_at as string | Date).toISOString(),
  };
}

function mapLedgerRow(row: Record<string, unknown>): TipLedgerRecord {
  return {
    id: String(row.id),
    eventType: row.event_type as TipLedgerEventType,
    ownerWallet: String(row.owner_wallet),
    counterpartyWallet: row.counterparty_wallet ? String(row.counterparty_wallet) : undefined,
    amountAtomic: String(row.amount_atomic),
    tokenMint: String(row.token_mint),
    status: String(row.status),
    txSignature: row.tx_signature ? String(row.tx_signature) : undefined,
    depositIntentId: row.deposit_intent_id ? String(row.deposit_intent_id) : undefined,
    withdrawalId: row.withdrawal_id ? String(row.withdrawal_id) : undefined,
    transferId: row.transfer_id ? String(row.transfer_id) : undefined,
    memo: row.memo ? String(row.memo) : undefined,
    metadata: (row.metadata ?? undefined) as Record<string, unknown> | undefined,
    createdAt: new Date(row.created_at as string | Date).toISOString(),
  };
}

function mapIntentRow(row: Record<string, unknown>): TipDepositIntent {
  return {
    intentId: String(row.id),
    ownerWallet: String(row.owner_wallet),
    amountAtomic: row.amount_atomic ? String(row.amount_atomic) : undefined,
    tokenMint: String(row.token_mint),
    vaultAddress: row.vault_address ? String(row.vault_address) : undefined,
    memo: String(row.memo),
    status: row.status as TipDepositIntent["status"],
    txSignature: row.tx_signature ? String(row.tx_signature) : undefined,
    expiresAt: new Date(row.expires_at as string | Date).toISOString(),
    createdAt: new Date(row.created_at as string | Date).toISOString(),
    updatedAt: new Date(row.updated_at as string | Date).toISOString(),
  };
}

export function createDefaultTipConfig(input: Partial<NullTipLedgerConfig> = {}): NullTipLedgerConfig {
  return {
    tokenMint: input.tokenMint ?? DEFAULT_TOKEN_MINT,
    vaultAddress: input.vaultAddress,
    tokenSymbol: input.tokenSymbol ?? DEFAULT_TOKEN_SYMBOL,
    decimals: input.decimals ?? DEFAULT_DECIMALS,
    maxSendAtomic: input.maxSendAtomic,
    maxWithdrawAtomic: input.maxWithdrawAtomic,
    sessionSecret: input.sessionSecret,
    sessionTtlSeconds: input.sessionTtlSeconds ?? 86_400,
    depositIntentTtlSeconds: input.depositIntentTtlSeconds ?? 3_600,
  };
}

export class TipSessionService {
  private readonly challenges = new Map<string, TipSessionChallenge>();

  constructor(
    private readonly config: NullTipLedgerConfig,
    private readonly now: () => Date,
  ) {}

  createChallenge(ownerWalletInput: string): TipSessionChallenge {
    const ownerWallet = sanitizeWallet(ownerWalletInput, "ownerWallet");
    const challengeId = uuid();
    const expiresAtMs = this.now().getTime() + 5 * 60_000;
    const message = [
      "DNA x402 NULL Tip Vault login",
      `wallet=${ownerWallet}`,
      `challenge=${challengeId}`,
      `expiresAt=${new Date(expiresAtMs).toISOString()}`,
      "This signature only proves wallet ownership. It does not move funds.",
    ].join("\n");
    const challenge = {
      challengeId,
      ownerWallet,
      message,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
    this.challenges.set(challengeId, challenge);
    return challenge;
  }

  verifyChallenge(input: { ownerWallet: string; challengeId: string; signature: string }): string {
    const ownerWallet = sanitizeWallet(input.ownerWallet, "ownerWallet");
    const challenge = this.challenges.get(input.challengeId);
    if (!challenge || challenge.ownerWallet !== ownerWallet) {
      throw new TipLedgerError("TIP_SESSION_CHALLENGE_INVALID", "Tip session challenge is invalid or already used.", 401);
    }
    if (new Date(challenge.expiresAt).getTime() < this.now().getTime()) {
      this.challenges.delete(input.challengeId);
      throw new TipLedgerError("TIP_SESSION_CHALLENGE_EXPIRED", "Tip session challenge expired.", 401);
    }

    let signature: Uint8Array;
    let publicKey: Uint8Array;
    try {
      signature = bs58.decode(input.signature);
      publicKey = bs58.decode(ownerWallet);
    } catch {
      throw new TipLedgerError("TIP_SESSION_SIGNATURE_INVALID", "Wallet signature is not valid base58.", 401);
    }
    const ok = nacl.sign.detached.verify(new TextEncoder().encode(challenge.message), signature, publicKey);
    this.challenges.delete(input.challengeId);
    if (!ok) {
      throw new TipLedgerError("TIP_SESSION_SIGNATURE_INVALID", "Wallet signature does not match the requested owner wallet.", 401);
    }
    return this.issueToken(ownerWallet);
  }

  issueToken(ownerWallet: string): string {
    const secret = this.config.sessionSecret;
    if (!secret || secret.length < 24) {
      throw new TipLedgerError("TIP_SESSION_SECRET_MISSING", "Tip sessions require a server-side session secret.", 503);
    }
    const iat = Math.floor(this.now().getTime() / 1000);
    const claims: TipSessionClaims = {
      ownerWallet,
      scope: "null_tips",
      iat,
      exp: iat + this.config.sessionTtlSeconds,
    };
    const payload = b64url(JSON.stringify(claims));
    return `${payload}.${hmac(payload, secret)}`;
  }

  verifyToken(token: string | undefined): TipSessionClaims {
    const secret = this.config.sessionSecret;
    if (!secret || secret.length < 24) {
      throw new TipLedgerError("TIP_SESSION_SECRET_MISSING", "Tip sessions require a server-side session secret.", 503);
    }
    if (!token) {
      throw new TipLedgerError("TIP_AUTH_REQUIRED", "Connect and sign with your wallet before using the tip vault.", 401);
    }
    const [payload, signature] = token.split(".");
    if (!payload || !signature || !timingSafeEqualString(hmac(payload, secret), signature)) {
      throw new TipLedgerError("TIP_AUTH_INVALID", "Tip session token is invalid.", 401);
    }
    let claims: TipSessionClaims;
    try {
      claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as TipSessionClaims;
    } catch {
      throw new TipLedgerError("TIP_AUTH_INVALID", "Tip session token payload is invalid.", 401);
    }
    if (claims.scope !== "null_tips" || !claims.ownerWallet) {
      throw new TipLedgerError("TIP_AUTH_INVALID", "Tip session token scope is invalid.", 401);
    }
    if (claims.exp <= Math.floor(this.now().getTime() / 1000)) {
      throw new TipLedgerError("TIP_AUTH_EXPIRED", "Tip session expired. Sign in again.", 401);
    }
    return claims;
  }
}

export class NullTipLedgerService {
  private readonly memoryAccounts = new Map<string, TipAccount>();
  private readonly memoryLedger: TipLedgerRecord[] = [];
  private readonly memoryIntents = new Map<string, TipDepositIntent>();
  private memoryWithdrawalsPaused = false;
  readonly sessions: TipSessionService;

  constructor(
    private readonly config: NullTipLedgerConfig,
    private readonly now: () => Date,
    private readonly db?: DbClient,
  ) {
    this.sessions = new TipSessionService(config, now);
  }

  configuredForDeposits(): boolean {
    return Boolean(this.config.vaultAddress && this.config.tokenMint !== DEFAULT_TOKEN_MINT);
  }

  async hasAccount(ownerWalletInput: string): Promise<boolean> {
    const ownerWallet = sanitizeWallet(ownerWalletInput, "ownerWallet");
    return Boolean(await this.findAccount(ownerWallet));
  }

  async ensureWalletAccount(ownerWalletInput: string): Promise<TipAccount> {
    const ownerWallet = sanitizeWallet(ownerWalletInput, "ownerWallet");
    return this.ensureAccount(ownerWallet);
  }

  async getBalance(ownerWalletInput: string): Promise<TipAccount> {
    const ownerWallet = sanitizeWallet(ownerWalletInput, "ownerWallet");
    return this.ensureAccount(ownerWallet);
  }

  async createDepositIntent(ownerWalletInput: string, amountAtomic?: string): Promise<TipDepositIntent> {
    const ownerWallet = sanitizeWallet(ownerWalletInput, "ownerWallet");
    if (amountAtomic) {
      assertAtomic(amountAtomic);
    }
    await this.ensureAccount(ownerWallet);
    const intentId = uuid();
    const createdAt = nowIso(this.now);
    const expiresAt = new Date(this.now().getTime() + this.config.depositIntentTtlSeconds * 1000).toISOString();
    const memo = `dna-null-tip:${intentId}`;
    const intent: TipDepositIntent = {
      intentId,
      ownerWallet,
      amountAtomic,
      tokenMint: this.config.tokenMint,
      vaultAddress: this.config.vaultAddress,
      memo,
      status: "PENDING",
      expiresAt,
      createdAt,
      updatedAt: createdAt,
    };

    if (this.db) {
      await this.db.query(
        `insert into tip_deposit_intents (id, owner_wallet, amount_atomic, token_mint, vault_address, memo, status, expires_at, created_at, updated_at)
         values ($1, $2, $3::numeric, $4, $5, $6, 'PENDING', $7, $8, $8)`,
        [intentId, ownerWallet, amountAtomic ?? null, this.config.tokenMint, this.config.vaultAddress ?? null, memo, expiresAt, createdAt],
      );
      await this.insertLedger({
        eventType: "deposit_intent_created",
        ownerWallet,
        amountAtomic: amountAtomic ?? ZERO,
        status: "PENDING",
        depositIntentId: intentId,
        memo,
        metadata: { vaultConfigured: this.configuredForDeposits(), vaultAddress: this.config.vaultAddress ?? null },
      });
      return intent;
    }

    this.memoryIntents.set(intentId, intent);
    this.pushMemoryLedger({
      eventType: "deposit_intent_created",
      ownerWallet,
      amountAtomic: amountAtomic ?? ZERO,
      status: "PENDING",
      depositIntentId: intentId,
      memo,
      metadata: { vaultConfigured: this.configuredForDeposits(), vaultAddress: this.config.vaultAddress ?? null },
    });
    return intent;
  }

  async confirmDeposit(input: {
    ownerWallet: string;
    depositIntentId: string;
    txSignature: string;
    amountAtomic: string;
    paymentVerifier: PaymentVerifier;
  }): Promise<{ account: TipAccount; ledger: TipLedgerRecord; intent: TipDepositIntent }> {
    const ownerWallet = sanitizeWallet(input.ownerWallet, "ownerWallet");
    const amount = assertAtomic(input.amountAtomic);
    if (!this.configuredForDeposits()) {
      throw new TipLedgerError("TIP_DEPOSIT_NOT_CONFIGURED", "NULL mint and vault address must be configured before live deposit confirmation.", 503);
    }
    const intent = await this.getDepositIntentForUpdate(input.depositIntentId);
    if (!intent || intent.ownerWallet !== ownerWallet) {
      throw new TipLedgerError("TIP_DEPOSIT_INTENT_NOT_FOUND", "Deposit intent was not found for this wallet.", 404);
    }
    if (intent.status === "CONFIRMED") {
      const account = await this.ensureAccount(ownerWallet);
      const ledger = (await this.listLedger(ownerWallet)).find((item) => item.depositIntentId === intent.intentId && item.eventType === "deposit_confirmed");
      return { account, ledger: ledger!, intent };
    }
    if (new Date(intent.expiresAt).getTime() < this.now().getTime()) {
      throw new TipLedgerError("TIP_DEPOSIT_INTENT_EXPIRED", "Deposit intent expired. Create a new deposit intent.", 409);
    }
    if (intent.amountAtomic && amount < BigInt(intent.amountAtomic)) {
      throw new TipLedgerError("TIP_DEPOSIT_UNDERPAY", "Deposit proof amount is below the deposit intent amount.", 402);
    }

    const quote: Quote = {
      quoteId: intent.intentId,
      resource: "/api/tips/deposit",
      amountAtomic: input.amountAtomic,
      feeAtomic: ZERO,
      totalAtomic: input.amountAtomic,
      mint: this.config.tokenMint,
      recipient: this.config.vaultAddress!,
      expiresAt: intent.expiresAt,
      settlement: ["transfer"],
      memoHash: crypto.createHash("sha256").update(intent.memo).digest("hex"),
    };
    const proof: PaymentProof = {
      settlement: "transfer",
      txSignature: input.txSignature,
      amountAtomic: input.amountAtomic,
    };
    const verified = await input.paymentVerifier.verify(quote, proof);
    if (!verified.ok) {
      throw new TipLedgerError("TIP_DEPOSIT_PROOF_REJECTED", verified.error ?? "Deposit proof rejected.", 402, {
        errorCode: verified.errorCode,
      });
    }

    if (this.db?.transaction) {
      return this.db.transaction(async (tx) => {
        const existing = await tx.query<Record<string, unknown>>(
          "select * from tip_ledger where tx_signature = $1 and event_type = 'deposit_confirmed' limit 1",
          [input.txSignature],
        );
        if (existing.rows[0]) {
          throw new TipLedgerError("TIP_DEPOSIT_REPLAY", "Deposit proof was already credited.", 409);
        }
        const account = await this.ensureAccount(ownerWallet, tx, true);
        const updated = await tx.query<Record<string, unknown>>(
          `update tip_accounts
           set balance_atomic = balance_atomic + $2::numeric,
               total_deposited_atomic = total_deposited_atomic + $2::numeric,
               version = version + 1,
               updated_at = $3
           where owner_wallet = $1
           returning *`,
          [ownerWallet, input.amountAtomic, nowIso(this.now)],
        );
        if (!account || !updated.rows[0]) {
          throw new TipLedgerError("TIP_ACCOUNT_NOT_FOUND", "Tip account missing during deposit confirmation.", 500);
        }
        await tx.query(
          "update tip_deposit_intents set status = 'CONFIRMED', tx_signature = $2, updated_at = $3 where id = $1",
          [intent.intentId, input.txSignature, nowIso(this.now)],
        );
        const ledger = await this.insertLedger({
          eventType: "deposit_confirmed",
          ownerWallet,
          amountAtomic: input.amountAtomic,
          status: "CONFIRMED",
          txSignature: input.txSignature,
          depositIntentId: intent.intentId,
          memo: intent.memo,
          metadata: { settledOnchain: verified.settledOnchain },
        }, tx);
        return {
          account: mapAccountRow(updated.rows[0]),
          ledger,
          intent: { ...intent, status: "CONFIRMED", txSignature: input.txSignature, updatedAt: nowIso(this.now) },
        };
      });
    }

    if (this.memoryLedger.some((item) => item.txSignature === input.txSignature && item.eventType === "deposit_confirmed")) {
      throw new TipLedgerError("TIP_DEPOSIT_REPLAY", "Deposit proof was already credited.", 409);
    }
    const account = await this.ensureAccount(ownerWallet);
    account.balanceAtomic = addAtomic(account.balanceAtomic, input.amountAtomic);
    account.totalDepositedAtomic = addAtomic(account.totalDepositedAtomic, input.amountAtomic);
    account.updatedAt = nowIso(this.now);
    intent.status = "CONFIRMED";
    intent.txSignature = input.txSignature;
    intent.updatedAt = account.updatedAt;
    const ledger = this.pushMemoryLedger({
      eventType: "deposit_confirmed",
      ownerWallet,
      amountAtomic: input.amountAtomic,
      status: "CONFIRMED",
      txSignature: input.txSignature,
      depositIntentId: intent.intentId,
      memo: intent.memo,
      metadata: { settledOnchain: verified.settledOnchain },
    });
    return { account, ledger, intent };
  }

  async sendTip(input: {
    fromOwnerWallet: string;
    toOwnerWallet: string;
    amountAtomic: string;
    memo?: string;
  }): Promise<{ transferId: string; sender: TipAccount; recipient: TipAccount; ledger: TipLedgerRecord[] }> {
    const fromOwnerWallet = sanitizeWallet(input.fromOwnerWallet, "fromOwnerWallet");
    const toOwnerWallet = sanitizeWallet(input.toOwnerWallet, "toOwnerWallet");
    if (fromOwnerWallet === toOwnerWallet) {
      throw new TipLedgerError("TIP_SELF_TRANSFER_FORBIDDEN", "Send tips to another wallet, not your own account.");
    }
    const amount = assertAtomic(input.amountAtomic);
    if (this.config.maxSendAtomic && amount > BigInt(this.config.maxSendAtomic)) {
      throw new TipLedgerError("TIP_SEND_CAP_EXCEEDED", "Tip exceeds the configured per-send cap.", 403);
    }
    const transferId = uuid();

    if (this.db?.transaction) {
      return this.db.transaction(async (tx) => {
        const sender = await this.ensureAccount(fromOwnerWallet, tx, true);
        const recipient = await this.findAccount(toOwnerWallet, tx, true);
        if (!recipient) {
          throw new TipLedgerError(
            "TIP_RECIPIENT_NOT_ENROLLED",
            "Recipient must open Tips and sign a tip session before receiving tips.",
            404,
          );
        }
        if (BigInt(sender.balanceAtomic) < amount) {
          throw new TipLedgerError("TIP_INSUFFICIENT_BALANCE", "Tip balance is too low for this send.", 402);
        }
        const timestamp = nowIso(this.now);
        const senderResult = await tx.query<Record<string, unknown>>(
          `update tip_accounts
           set balance_atomic = balance_atomic - $2::numeric,
               total_sent_atomic = total_sent_atomic + $2::numeric,
               version = version + 1,
               updated_at = $3
           where owner_wallet = $1
           returning *`,
          [fromOwnerWallet, input.amountAtomic, timestamp],
        );
        const recipientResult = await tx.query<Record<string, unknown>>(
          `update tip_accounts
           set balance_atomic = balance_atomic + $2::numeric,
               total_received_atomic = total_received_atomic + $2::numeric,
               version = version + 1,
               updated_at = $3
           where owner_wallet = $1
           returning *`,
          [toOwnerWallet, input.amountAtomic, timestamp],
        );
        const sent = await this.insertLedger({
          eventType: "tip_sent",
          ownerWallet: fromOwnerWallet,
          counterpartyWallet: toOwnerWallet,
          amountAtomic: input.amountAtomic,
          status: "POSTED",
          transferId,
          memo: input.memo,
        }, tx);
        const received = await this.insertLedger({
          eventType: "tip_received",
          ownerWallet: toOwnerWallet,
          counterpartyWallet: fromOwnerWallet,
          amountAtomic: input.amountAtomic,
          status: "POSTED",
          transferId,
          memo: input.memo,
        }, tx);
        return {
          transferId,
          sender: mapAccountRow(senderResult.rows[0]),
          recipient: mapAccountRow(recipientResult.rows[0]),
          ledger: [sent, received],
        };
      });
    }

    const sender = await this.ensureAccount(fromOwnerWallet);
    const recipient = await this.findAccount(toOwnerWallet);
    if (!recipient) {
      throw new TipLedgerError(
        "TIP_RECIPIENT_NOT_ENROLLED",
        "Recipient must open Tips and sign a tip session before receiving tips.",
        404,
      );
    }
    if (BigInt(sender.balanceAtomic) < amount) {
      throw new TipLedgerError("TIP_INSUFFICIENT_BALANCE", "Tip balance is too low for this send.", 402);
    }
    sender.balanceAtomic = subAtomic(sender.balanceAtomic, input.amountAtomic);
    sender.totalSentAtomic = addAtomic(sender.totalSentAtomic, input.amountAtomic);
    sender.updatedAt = nowIso(this.now);
    recipient.balanceAtomic = addAtomic(recipient.balanceAtomic, input.amountAtomic);
    recipient.totalReceivedAtomic = addAtomic(recipient.totalReceivedAtomic, input.amountAtomic);
    recipient.updatedAt = sender.updatedAt;
    const sent = this.pushMemoryLedger({
      eventType: "tip_sent",
      ownerWallet: fromOwnerWallet,
      counterpartyWallet: toOwnerWallet,
      amountAtomic: input.amountAtomic,
      status: "POSTED",
      transferId,
      memo: input.memo,
    });
    const received = this.pushMemoryLedger({
      eventType: "tip_received",
      ownerWallet: toOwnerWallet,
      counterpartyWallet: fromOwnerWallet,
      amountAtomic: input.amountAtomic,
      status: "POSTED",
      transferId,
      memo: input.memo,
    });
    return { transferId, sender, recipient, ledger: [sent, received] };
  }

  async requestWithdrawal(input: {
    ownerWallet: string;
    recipientWallet: string;
    amountAtomic: string;
  }): Promise<{ withdrawalId: string; account: TipAccount; ledger: TipLedgerRecord }> {
    const ownerWallet = sanitizeWallet(input.ownerWallet, "ownerWallet");
    const recipientWallet = sanitizeWallet(input.recipientWallet, "recipientWallet");
    const amount = assertAtomic(input.amountAtomic);
    if (this.config.maxWithdrawAtomic && amount > BigInt(this.config.maxWithdrawAtomic)) {
      throw new TipLedgerError("TIP_WITHDRAW_CAP_EXCEEDED", "Withdrawal exceeds the configured per-request cap.", 403);
    }
    if (await this.withdrawalsPaused()) {
      throw new TipLedgerError("TIP_WITHDRAWALS_PAUSED", "Withdrawals are paused until vault reconciliation is green.", 503);
    }
    const withdrawalId = uuid();

    if (this.db?.transaction) {
      return this.db.transaction(async (tx) => {
        await this.ensureAccount(ownerWallet, tx);
        const locked = await tx.query<Record<string, unknown>>(
          "select * from tip_accounts where owner_wallet = $1 for update",
          [ownerWallet],
        );
        const account = mapAccountRow(locked.rows[0]);
        if (BigInt(account.balanceAtomic) < amount) {
          throw new TipLedgerError("TIP_INSUFFICIENT_BALANCE", "Tip balance is too low for this withdrawal.", 402);
        }
        const updated = await tx.query<Record<string, unknown>>(
          `update tip_accounts
           set balance_atomic = balance_atomic - $2::numeric,
               pending_withdrawal_atomic = pending_withdrawal_atomic + $2::numeric,
               version = version + 1,
               updated_at = $3
           where owner_wallet = $1
           returning *`,
          [ownerWallet, input.amountAtomic, nowIso(this.now)],
        );
        const ledger = await this.insertLedger({
          eventType: "withdrawal_requested",
          ownerWallet,
          counterpartyWallet: recipientWallet,
          amountAtomic: input.amountAtomic,
          status: "PENDING_MANUAL_REVIEW",
          withdrawalId,
          metadata: { recipientWallet },
        }, tx);
        return { withdrawalId, account: mapAccountRow(updated.rows[0]), ledger };
      });
    }

    const account = await this.ensureAccount(ownerWallet);
    if (BigInt(account.balanceAtomic) < amount) {
      throw new TipLedgerError("TIP_INSUFFICIENT_BALANCE", "Tip balance is too low for this withdrawal.", 402);
    }
    account.balanceAtomic = subAtomic(account.balanceAtomic, input.amountAtomic);
    account.pendingWithdrawalAtomic = addAtomic(account.pendingWithdrawalAtomic, input.amountAtomic);
    account.updatedAt = nowIso(this.now);
    const ledger = this.pushMemoryLedger({
      eventType: "withdrawal_requested",
      ownerWallet,
      counterpartyWallet: recipientWallet,
      amountAtomic: input.amountAtomic,
      status: "PENDING_MANUAL_REVIEW",
      withdrawalId,
      metadata: { recipientWallet },
    });
    return { withdrawalId, account, ledger };
  }

  async adminAdjust(input: {
    ownerWallet: string;
    amountAtomic: string;
    direction: "credit" | "debit";
    reason: string;
    actorId?: string;
  }): Promise<{ account: TipAccount; ledger: TipLedgerRecord }> {
    const ownerWallet = sanitizeWallet(input.ownerWallet, "ownerWallet");
    const amount = assertAtomic(input.amountAtomic);
    if (input.reason.trim().length < 8) {
      throw new TipLedgerError("TIP_ADJUSTMENT_REASON_REQUIRED", "Admin adjustments require a concrete reason.");
    }

    if (this.db?.transaction) {
      return this.db.transaction(async (tx) => {
        await this.ensureAccount(ownerWallet, tx);
        const account = await tx.query<Record<string, unknown>>(
          "select * from tip_accounts where owner_wallet = $1 for update",
          [ownerWallet],
        );
        const current = mapAccountRow(account.rows[0]);
        if (input.direction === "debit" && BigInt(current.balanceAtomic) < amount) {
          throw new TipLedgerError("TIP_INSUFFICIENT_BALANCE", "Cannot debit more than current tip balance.", 402);
        }
        const operator = input.direction === "credit" ? "+" : "-";
        const updated = await tx.query<Record<string, unknown>>(
          `update tip_accounts
           set balance_atomic = balance_atomic ${operator} $2::numeric,
               version = version + 1,
               updated_at = $3
           where owner_wallet = $1
           returning *`,
          [ownerWallet, input.amountAtomic, nowIso(this.now)],
        );
        const ledger = await this.insertLedger({
          eventType: "admin_adjustment",
          ownerWallet,
          amountAtomic: input.amountAtomic,
          status: input.direction.toUpperCase(),
          metadata: { reason: input.reason, actorId: input.actorId },
        }, tx);
        return { account: mapAccountRow(updated.rows[0]), ledger };
      });
    }

    const account = await this.ensureAccount(ownerWallet);
    if (input.direction === "debit" && BigInt(account.balanceAtomic) < amount) {
      throw new TipLedgerError("TIP_INSUFFICIENT_BALANCE", "Cannot debit more than current tip balance.", 402);
    }
    account.balanceAtomic = input.direction === "credit"
      ? addAtomic(account.balanceAtomic, input.amountAtomic)
      : subAtomic(account.balanceAtomic, input.amountAtomic);
    account.updatedAt = nowIso(this.now);
    const ledger = this.pushMemoryLedger({
      eventType: "admin_adjustment",
      ownerWallet,
      amountAtomic: input.amountAtomic,
      status: input.direction.toUpperCase(),
      metadata: { reason: input.reason, actorId: input.actorId },
    });
    return { account, ledger };
  }

  async listLedger(ownerWalletInput: string, limit = 50): Promise<TipLedgerRecord[]> {
    const ownerWallet = sanitizeWallet(ownerWalletInput, "ownerWallet");
    if (this.db) {
      const result = await this.db.query<Record<string, unknown>>(
        `select * from tip_ledger
         where owner_wallet = $1
         order by created_at desc, id desc
         limit $2`,
        [ownerWallet, Math.min(Math.max(limit, 1), 200)],
      );
      return result.rows.map(mapLedgerRow);
    }
    return this.memoryLedger
      .filter((item) => item.ownerWallet === ownerWallet)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, Math.min(Math.max(limit, 1), 200));
  }

  async reconcile(input: { vaultBalanceAtomic: string; actorId?: string }): Promise<{
    ok: boolean;
    liabilityAtomic: string;
    vaultBalanceAtomic: string;
    withdrawalsPaused: boolean;
  }> {
    assertAtomic(input.vaultBalanceAtomic, "vaultBalanceAtomic");
    const liabilityAtomic = await this.liabilityAtomic();
    const ok = BigInt(input.vaultBalanceAtomic) >= BigInt(liabilityAtomic);
    await this.setWithdrawalsPaused(!ok, ok ? "vault_reconciliation_green" : "vault_balance_below_internal_liability", input.actorId);
    if (this.db) {
      await this.db.query(
        `insert into tip_reconciliations (id, liability_atomic, vault_balance_atomic, ok, withdrawals_paused, metadata, created_at)
         values ($1, $2::numeric, $3::numeric, $4, $5, $6::jsonb, $7)`,
        [uuid(), liabilityAtomic, input.vaultBalanceAtomic, ok, !ok, JSON.stringify({ actorId: input.actorId }), nowIso(this.now)],
      );
    } else {
      this.pushMemoryLedger({
        eventType: "reconciliation",
        ownerWallet: "SYSTEM",
        amountAtomic: liabilityAtomic,
        status: ok ? "OK" : "MISMATCH",
        metadata: { vaultBalanceAtomic: input.vaultBalanceAtomic, actorId: input.actorId },
      });
    }
    return {
      ok,
      liabilityAtomic,
      vaultBalanceAtomic: input.vaultBalanceAtomic,
      withdrawalsPaused: !ok,
    };
  }

  async setWithdrawalsPaused(paused: boolean, reason: string, actorId?: string): Promise<void> {
    if (this.db) {
      await this.db.query(
        `insert into tip_admin_state (id, withdrawals_paused, reason, actor_id, updated_at)
         values ('global', $1, $2, $3, $4)
         on conflict (id) do update
         set withdrawals_paused = excluded.withdrawals_paused,
             reason = excluded.reason,
             actor_id = excluded.actor_id,
             updated_at = excluded.updated_at`,
        [paused, reason, actorId ?? null, nowIso(this.now)],
      );
      return;
    }
    this.memoryWithdrawalsPaused = paused;
  }

  async withdrawalsPaused(): Promise<boolean> {
    if (this.db) {
      const result = await this.db.query<{ withdrawals_paused: boolean }>(
        "select withdrawals_paused from tip_admin_state where id = 'global'",
      );
      return Boolean(result.rows[0]?.withdrawals_paused);
    }
    return this.memoryWithdrawalsPaused;
  }

  private async liabilityAtomic(): Promise<string> {
    if (this.db) {
      const result = await this.db.query<{ liability_atomic: string }>(
        "select coalesce(sum(balance_atomic + pending_withdrawal_atomic), 0)::text as liability_atomic from tip_accounts",
      );
      return String(result.rows[0]?.liability_atomic ?? ZERO);
    }
    let total = 0n;
    for (const account of this.memoryAccounts.values()) {
      total += BigInt(account.balanceAtomic) + BigInt(account.pendingWithdrawalAtomic);
    }
    return total.toString(10);
  }

  private async getDepositIntentForUpdate(intentId: string): Promise<TipDepositIntent | undefined> {
    if (this.db) {
      const result = await this.db.query<Record<string, unknown>>(
        "select * from tip_deposit_intents where id = $1 limit 1",
        [intentId],
      );
      return result.rows[0] ? mapIntentRow(result.rows[0]) : undefined;
    }
    return this.memoryIntents.get(intentId);
  }

  private async findAccount(
    ownerWallet: string,
    db: DbClient | undefined = this.db,
    lock = false,
  ): Promise<TipAccount | undefined> {
    if (db) {
      const result = await db.query<Record<string, unknown>>(
        `select * from tip_accounts where owner_wallet = $1 ${lock ? "for update" : ""}`,
        [ownerWallet],
      );
      return result.rows[0] ? mapAccountRow(result.rows[0]) : undefined;
    }
    return this.memoryAccounts.get(ownerWallet);
  }

  private async ensureAccount(ownerWallet: string, db: DbClient | undefined = this.db, lock = false): Promise<TipAccount> {
    if (db) {
      const inserted = await db.query<Record<string, unknown>>(
        `insert into tip_accounts (owner_wallet, token_mint, created_at, updated_at)
         values ($1, $2, $3, $3)
         on conflict (owner_wallet) do nothing
         returning *`,
        [ownerWallet, this.config.tokenMint, nowIso(this.now)],
      );
      if (inserted.rows[0]) {
        await this.insertLedger({
          eventType: "account_created",
          ownerWallet,
          amountAtomic: ZERO,
          status: "ACTIVE",
        }, db);
        return mapAccountRow(inserted.rows[0]);
      }
      const result = await db.query<Record<string, unknown>>(
        `select * from tip_accounts where owner_wallet = $1 ${lock ? "for update" : ""}`,
        [ownerWallet],
      );
      if (!result.rows[0]) {
        throw new TipLedgerError("TIP_ACCOUNT_NOT_FOUND", "Tip account could not be created.", 500);
      }
      return mapAccountRow(result.rows[0]);
    }

    const existing = this.memoryAccounts.get(ownerWallet);
    if (existing) {
      return existing;
    }
    const timestamp = nowIso(this.now);
    const created: TipAccount = {
      ownerWallet,
      tokenMint: this.config.tokenMint,
      balanceAtomic: ZERO,
      pendingWithdrawalAtomic: ZERO,
      totalDepositedAtomic: ZERO,
      totalSentAtomic: ZERO,
      totalReceivedAtomic: ZERO,
      totalWithdrawnAtomic: ZERO,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.memoryAccounts.set(ownerWallet, created);
    this.pushMemoryLedger({
      eventType: "account_created",
      ownerWallet,
      amountAtomic: ZERO,
      status: "ACTIVE",
    });
    return created;
  }

  private async insertLedger(
    input: Omit<TipLedgerRecord, "id" | "tokenMint" | "createdAt">,
    db: DbClient | undefined = this.db,
  ): Promise<TipLedgerRecord> {
    const id = uuid();
    const createdAt = nowIso(this.now);
    if (db) {
      const result = await db.query<Record<string, unknown>>(
        `insert into tip_ledger
         (id, event_type, owner_wallet, counterparty_wallet, amount_atomic, token_mint, status, tx_signature,
          deposit_intent_id, withdrawal_id, transfer_id, memo, metadata, created_at)
         values ($1, $2, $3, $4, $5::numeric, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14)
         returning *`,
        [
          id,
          input.eventType,
          input.ownerWallet,
          input.counterpartyWallet ?? null,
          input.amountAtomic,
          this.config.tokenMint,
          input.status,
          input.txSignature ?? null,
          input.depositIntentId ?? null,
          input.withdrawalId ?? null,
          input.transferId ?? null,
          input.memo ?? null,
          JSON.stringify(input.metadata ?? {}),
          createdAt,
        ],
      );
      return mapLedgerRow(result.rows[0]);
    }
    return this.pushMemoryLedger(input);
  }

  private pushMemoryLedger(input: Omit<TipLedgerRecord, "id" | "tokenMint" | "createdAt">): TipLedgerRecord {
    const record: TipLedgerRecord = {
      id: uuid(),
      tokenMint: this.config.tokenMint,
      createdAt: nowIso(this.now),
      ...input,
    };
    this.memoryLedger.push(record);
    return record;
  }
}
