export type SupportedChain = "solana" | "base" | "arbitrum" | "polygon" | "ethereum";
export type SupportedTokenSymbol = "USDC" | "USDT" | "PYUSD" | "native";

export interface SettlementOption {
  chain: SupportedChain;
  tokenSymbol: SupportedTokenSymbol;
  tokenAddressOrMint: string;
  amount: string;
  recipient: string;
  expiry: string;
  verifier: string;
  bridgeRequired: boolean;
  estimatedBridgeTime?: string;
  estimatedFees?: string;
  riskFlags: string[];
}

export interface ChainHealth {
  chain: SupportedChain;
  available: boolean;
  riskFlags: string[];
}

export interface TokenRisk {
  chain: SupportedChain;
  tokenSymbol: SupportedTokenSymbol;
  tokenAddressOrMint: string;
  depegFlag: "NONE" | "WARN" | "BLOCK";
}

export class SettlementRegistry {
  constructor(
    private readonly chainHealth: ChainHealth[],
    private readonly tokenRisks: TokenRisk[],
  ) {}

  availableOptions(options: SettlementOption[]): SettlementOption[] {
    return options.filter((option) => {
      const health = this.chainHealth.find((item) => item.chain === option.chain);
      const risk = this.tokenRisks.find((item) =>
        item.chain === option.chain
        && item.tokenSymbol === option.tokenSymbol
        && item.tokenAddressOrMint === option.tokenAddressOrMint);
      if (health && !health.available) {
        return false;
      }
      if (risk?.depegFlag === "BLOCK") {
        return false;
      }
      return true;
    }).map((option) => {
      const health = this.chainHealth.find((item) => item.chain === option.chain);
      const risk = this.tokenRisks.find((item) =>
        item.chain === option.chain
        && item.tokenSymbol === option.tokenSymbol
        && item.tokenAddressOrMint === option.tokenAddressOrMint);
      return {
        ...option,
        riskFlags: [
          ...option.riskFlags,
          ...(health?.riskFlags ?? []),
          ...(risk?.depegFlag === "WARN" ? ["DEPEG_WARN"] : []),
        ].sort(),
      };
    });
  }

  assertPaymentMatches(option: SettlementOption, payment: { chain: string; tokenAddressOrMint: string; recipient: string }): void {
    if (payment.chain !== option.chain) {
      throw new Error("wrong chain");
    }
    if (payment.tokenAddressOrMint !== option.tokenAddressOrMint) {
      throw new Error("wrong token");
    }
    if (payment.recipient !== option.recipient) {
      throw new Error("wrong recipient");
    }
  }
}
