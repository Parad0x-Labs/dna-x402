import React from "react";
import { BrowserWalletProvider } from "../lib/wallet";
import { ControlRoom } from "./ControlRoom";

export const ControlRoomWallet: React.FC = () => (
  <BrowserWalletProvider>
    <ControlRoom />
  </BrowserWalletProvider>
);
