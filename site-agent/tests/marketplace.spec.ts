import { expect, test } from "@playwright/test";

test("marketplace exposes buyer listings, seller wizard, receipt, and control plane", async ({ page }) => {
  await page.goto("/agent/marketplace");

  await expect(page.getByRole("heading", { name: "Marketplace Control Surface" })).toBeVisible();
  await expect(page.getByText("Discover signed seller capabilities")).toBeVisible();

  await expect(page.getByRole("heading", { name: "Buyer Marketplace" })).toBeVisible();
  await expect(page.getByText("Fast Research Agent")).toBeVisible();
  await expect(page.getByText("GPU Render Slot")).toBeVisible();
  await expect(page.getByText("Physical Goods Demo")).toBeVisible();
  await expect(page.getByText("OUT_OF_BETA", { exact: true })).toBeVisible();

  await expect(page.getByRole("heading", { name: "Quote Comparison" })).toBeVisible();
  await expect(page.getByText("Not in beta scope")).toBeVisible();
  await expect(page.getByText("Policy: ALLOW / version policy-v1")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Receipt Viewer" })).toBeVisible();
  await expect(page.getByText("policyDecisionHash")).toBeVisible();
  await expect(page.getByText("feeWaterfallHash")).toBeVisible();

  await expect(page.getByRole("heading", { name: "Seller Wizard" })).toBeVisible();
  await expect(page.getByText("PolicyInputV1 pre-check and review queue")).toBeVisible();
  await expect(page.getByText("preview, sign, version, publish")).toBeVisible();

  await expect(page.getByRole("heading", { name: "Control Plane" })).toBeVisible();
  await expect(page.getByText("PII off immutable proof")).toBeVisible();
  await expect(page.getByText("denylist evidence, appeal queue")).toBeVisible();

  await page.getByLabel("Capability").selectOption("market_data");
  await expect(page.getByRole("heading", { name: "Market Data Feed" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Fast Research Agent" })).toHaveCount(0);
});
