import { assertBackendRelayOnly } from "./security.js";
import { OrderValidationInput, validateOrderForSubmission } from "./trading.js";

const BUILDER_ENV_ALIASES: Record<string, string[]> = {
  POLYMARKET_BUILDER_CODE: ["POLY_BUILDER_CODE"],
  POLYMARKET_BUILDER_API_KEY: ["POLYMARKET_API_KEY"],
  POLYMARKET_BUILDER_SECRET: ["POLYMARKET_API_SECRET"],
  POLYMARKET_BUILDER_PASSPHRASE: ["POLYMARKET_API_PASSPHRASE"],
};

const BUILDER_ENV_KEYS = [
  "POLYMARKET_BUILDER_CODE",
  "POLYMARKET_BUILDER_API_KEY",
  "POLYMARKET_BUILDER_SECRET",
  "POLYMARKET_BUILDER_PASSPHRASE",
] as const;

const LIVE_ORDER_EXTRA_KEYS = [
  "POLYMARKET_PRIVATE_KEY",
  "DEPOSIT_WALLET_ADDRESS",
] as const;

type BuilderEnvKey = typeof BUILDER_ENV_KEYS[number];

function acceptedNames(name: string): string[] {
  return [name, ...(BUILDER_ENV_ALIASES[name] ?? [])];
}

function resolveEnvValue(name: string, env: NodeJS.ProcessEnv): { value?: string; sourceName?: string } {
  for (const key of acceptedNames(name)) {
    const value = env[key];
    if (value && value.trim().length > 0) {
      return { value, sourceName: key };
    }
  }
  return {};
}

export interface PolymarketEnvReadinessEntry {
  canonicalName: string;
  acceptedNames: string[];
  present: boolean;
  sourceName?: string;
}

export interface PolymarketBuilderEnvReadiness {
  ready: boolean;
  entries: PolymarketEnvReadinessEntry[];
  builderCode?: {
    value: string;
    sourceName: string;
  };
}

export interface PolymarketLiveReadinessSnapshot {
  builder: PolymarketBuilderEnvReadiness;
  liveOrderExtras: PolymarketEnvReadinessEntry[];
  mode: "PER_USER_DEPOSIT_WALLET_SIGNER";
  notes: string[];
}

export function resolvePolymarketBuilderEnvReadiness(env: NodeJS.ProcessEnv = process.env): PolymarketBuilderEnvReadiness {
  const entries = BUILDER_ENV_KEYS.map((canonicalName) => {
    const resolved = resolveEnvValue(canonicalName, env);
    return {
      canonicalName,
      acceptedNames: acceptedNames(canonicalName),
      present: Boolean(resolved.value),
      sourceName: resolved.sourceName,
    };
  });

  const builderCodeResolved = resolveEnvValue("POLYMARKET_BUILDER_CODE", env);

  return {
    ready: entries.every((entry) => entry.present),
    entries,
    builderCode: builderCodeResolved.value && builderCodeResolved.sourceName
      ? { value: builderCodeResolved.value, sourceName: builderCodeResolved.sourceName }
      : undefined,
  };
}

export function resolvePolymarketLiveReadiness(env: NodeJS.ProcessEnv = process.env): PolymarketLiveReadinessSnapshot {
  const builder = resolvePolymarketBuilderEnvReadiness(env);
  const liveOrderExtras = LIVE_ORDER_EXTRA_KEYS.map((canonicalName) => {
    const value = env[canonicalName];
    return {
      canonicalName,
      acceptedNames: [canonicalName],
      present: Boolean(value && value.trim().length > 0),
      sourceName: value && value.trim().length > 0 ? canonicalName : undefined,
    };
  });

  return {
    builder,
    liveOrderExtras,
    mode: "PER_USER_DEPOSIT_WALLET_SIGNER",
    notes: [
      "Builder credentials are shared on server for authenticated builder headers only.",
      "Every live order still requires a user-owned deposit wallet signer context.",
      "Backend signing and backend custody remain forbidden.",
    ],
  };
}

export interface PolymarketUserOrderPrecheckInput extends Omit<OrderValidationInput, "builderCode"> {
  agentId: string;
  ownerWallet: string;
  builderCode?: string;
}

export interface PolymarketUserOrderPrecheckResult {
  ok: boolean;
  errors: string[];
  builderCredentialsReady: boolean;
  builderCodeSource: "request" | "env" | "missing";
  mode: "PER_USER_DEPOSIT_WALLET_SIGNER";
}

export function precheckPolymarketUserOrder(
  input: PolymarketUserOrderPrecheckInput,
  env: NodeJS.ProcessEnv = process.env,
): PolymarketUserOrderPrecheckResult {
  assertBackendRelayOnly(input);
  const builderReadiness = resolvePolymarketBuilderEnvReadiness(env);
  const builderCodeFromEnv = builderReadiness.builderCode?.value;
  const builderCode = input.builderCode ?? builderCodeFromEnv;
  const builderCodeSource: PolymarketUserOrderPrecheckResult["builderCodeSource"] = input.builderCode
    ? "request"
    : builderCodeFromEnv
      ? "env"
      : "missing";

  const validation = validateOrderForSubmission({
    ...input,
    builderCode,
  });

  const errors = [...validation.errors];
  if (!builderReadiness.ready) {
    errors.push("builder_credentials_missing");
  }

  return {
    ok: errors.length === 0,
    errors,
    builderCredentialsReady: builderReadiness.ready,
    builderCodeSource,
    mode: "PER_USER_DEPOSIT_WALLET_SIGNER",
  };
}
