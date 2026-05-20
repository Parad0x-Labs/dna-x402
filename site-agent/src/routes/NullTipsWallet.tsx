import React from "react";
import { BrowserWalletProvider } from "../lib/wallet";
import { NullTips } from "./NullTips";

export const NullTipsWallet: React.FC = () => (
  <BrowserWalletProvider>
    <NullTips />
  </BrowserWalletProvider>
);

