import { expect, test } from "@playwright/test";

test("polymarket agent workbench shows proof gates and wallet model", async ({ page }) => {
  await page.goto("/agent/polymarket");

  await expect(page.getByRole("heading", { name: "/agent/polymarket" })).toBeVisible();
  await expect(page.getByText("Signature proof green")).toBeVisible();
  await expect(page.getByText("Deposit wallet proof green")).toBeVisible();
  await expect(page.getByText("Default deposit")).toBeVisible();
  await expect(page.getByText("Solana USDC", { exact: true })).toBeVisible();
  await expect(page.getByText("pUSD / USD")).toBeVisible();
  await expect(page.getByText("No private keys, no seed phrases, no signing")).toBeVisible();
  await expect(page.getByText("POLY_1271 no-submit fixture has zero mismatches.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "PnL and win tracking" })).toBeVisible();
  await expect(page.getByText("Average entry", { exact: true })).toBeVisible();
  await expect(page.getByText("0.533333 pUSD")).toBeVisible();
  await expect(page.getByText("Win rate", { exact: true })).toBeVisible();
  await expect(page.getByText("50.00%")).toBeVisible();
  await expect(page.getByText("2% of positive finalized copied-lot PnL only", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Balances and positions" })).toBeVisible();
  await expect(page.getByText("Conditional positions")).toBeVisible();
  await expect(page.getByLabel("Live PnL tracker chart")).toBeVisible();
  await expect(page.getByRole("button", { name: "Positions" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("cell", { name: "Fed cuts rates before July" })).toBeVisible();
  await page.getByRole("button", { name: "Open orders" }).click();
  await expect(page.getByRole("cell", { name: "ETH all-time high before July" })).toBeVisible();
  await page.getByRole("button", { name: "History" }).click();
  await expect(page.getByRole("cell", { name: "POLY_1271 order signed" })).toBeVisible();
  await page.getByRole("button", { name: "Positions" }).click();
  await expect(page.getByRole("heading", { name: "Deposit flow" })).toBeVisible();
  await expect(page.getByText("Fetch /supported-assets live before choices render")).toBeVisible();
  await expect(page.getByRole("button", { name: "Fetch supported assets requires bridge gate" })).toBeDisabled();
  await expect(page.getByRole("heading", { name: "Market browser and order ticket" })).toBeVisible();
  await expect(page.getByLabel("Market search")).toBeVisible();
  await expect(page.getByRole("button", { name: "Validate order requires live market gate" })).toBeDisabled();
  await expect(page.getByRole("heading", { name: "Copy trading setup" })).toBeVisible();
  await expect(page.getByText("public profile /alpha/sharp-money-desk")).toBeVisible();
  await expect(page.getByRole("button", { name: "Enable active-session copy requires live fanout gate" })).toBeDisabled();
  await expect(page.getByRole("heading", { name: "Agent profile and risk controls" })).toBeVisible();
  await expect(page.getByText("Agent slug is immutable after creation")).toBeVisible();
  await expect(page.getByText("Different recipient requires admin approval, reason, and audit log id")).toBeVisible();
  await expect(page.getByText("Max daily loss")).toBeVisible();
  await expect(page.getByText("$50")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Withdrawal intent flow" })).toBeVisible();
  await expect(page.getByText("Quote preview")).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign pUSD transfer requires wallet confirmation" })).toBeDisabled();
  await expect(page.getByRole("heading", { name: "Bridge and withdrawal state machines" })).toBeVisible();
  await expect(page.getByText("Quote-bound intent, final confirmation before address creation")).toBeVisible();
  await expect(page.getByText("Not in beta scope until user-confirmed approval, pUSD transfer")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Operations and safety" })).toBeVisible();
  await expect(page.getByText("Global trading kill switch")).toBeVisible();
  await expect(page.getByText("Reconciliation queue")).toBeVisible();
  await expect(page.getByRole("button", { name: "Solana USDC deposit requires bridge gate" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Manual order requires bridge gate" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Withdrawal intent requires pUSD transfer gate" })).toBeDisabled();
  await expect(page.getByText("No unattended live trading")).toBeVisible();
});

test("polymarket agent workbench connects mocked Phantom EVM and locks agent name", async ({ page }) => {
  await page.addInitScript(() => {
    let chainId = "0x1";
    Object.defineProperty(window, "ethereum", {
      configurable: true,
      value: {
        request: async ({ method, params }: { method: string; params?: Array<{ chainId?: string }> }) => {
          if (method === "eth_requestAccounts") {
            return ["0x1111111111111111111111111111111111111111"];
          }
          if (method === "eth_chainId") {
            return chainId;
          }
          if (method === "wallet_switchEthereumChain") {
            chainId = params?.[0]?.chainId ?? chainId;
            return null;
          }
          return null;
        },
      },
    });
  });

  await page.goto("/agent/polymarket");
  await page.getByRole("button", { name: "Connect Phantom EVM" }).click();

  await expect(page.getByText("0x1111...111111 on Polygon")).toBeVisible();
  await page.getByLabel("Agent name").fill("Sharp Money Desk");
  await expect(page.getByText("/agent/polymarket/sharp-money-desk")).toBeVisible();
  await page.getByRole("button", { name: "Lock agent name" }).click();
  await expect(page.getByRole("button", { name: "Agent name locked" })).toBeDisabled();
  await expect(page.getByRole("link", { name: "Open public alpha page" })).toHaveAttribute("href", "/agent/polymarket/sharp-money-desk");
});

test("public alpha profile exposes PnL proof and keeps copy controls gated", async ({ page }) => {
  await page.goto("/agent/polymarket/sharp-money-desk");

  await expect(page.getByRole("heading", { name: "/alpha/sharp-money-desk" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Performance" })).toBeVisible();
  await expect(page.getByText("0.533333 pUSD")).toBeVisible();
  await expect(page.getByText("All-time PnL")).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy all categories requires live fanout gate" })).toBeDisabled();
  await expect(page.getByText("No hosted unattended signer exists in V1.")).toBeVisible();
});
