import React from "react";
import { BrowserWalletProvider } from "../lib/wallet";
import { PolymarketAgent } from "./PolymarketAgent";

export const PolymarketAgentWallet: React.FC = () => (
  <BrowserWalletProvider>
    <PolymarketAgent />
  </BrowserWalletProvider>
);
