import { expect, test } from "@playwright/test";

test("NULL tips page renders wallet-separated tip ledger surface", async ({ page }) => {
  await page.route("**/api/tips/config", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        tokenSymbol: "NULL",
        tokenMint: "NullMint1111111111111111111111111111111111",
        decimals: 6,
        vaultAddress: "NullVault111111111111111111111111111111111",
        vaultConfigured: true,
        withdrawalsPaused: false,
      }),
    });
  });

  await page.goto("/agent/tips");

  await expect(page.getByRole("heading", { name: "Fee-free in-app NULL tipping" })).toBeVisible();
  await expect(page.getByText("Agent wallet balance")).toBeVisible();
  await expect(page.getByText("Tip balance", { exact: true })).toBeVisible();
  await expect(page.getByText("Sender is derived from your signed wallet session.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Create Deposit Intent" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Send NULL Tip" })).toBeDisabled();
});
