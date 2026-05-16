import { expect, test } from "@playwright/test";

test("creator start page exposes public and restricted agent templates", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          (window as unknown as { __copiedCommand?: string }).__copiedCommand = value;
        },
      },
    });
  });

  await page.goto("/agent/start");

  await expect(page.getByRole("heading", { name: "/agent/start" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Paid Service" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Marketplace Seller" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Auction Tool" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Strategy Research" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Restricted Market" })).toBeVisible();
  await expect(page.getByText("HTTP 451")).toBeVisible();
  await expect(page.getByText("Separate Gate")).toBeVisible();

  const copyButtons = page.getByRole("button", { name: "Copy Command" });
  await expect(copyButtons).toHaveCount(5);
  await copyButtons.first().click();
  await expect(page.getByRole("button", { name: "Copied" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __copiedCommand?: string }).__copiedCommand))
    .toBe("npx dna-x402 init agent my-service-agent --template service");
});

test("creator start page fits narrow screens", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto("/agent/start");

  await expect(page.getByRole("heading", { name: "/agent/start" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Restricted Market" })).toBeVisible();
  await expect(page.locator(".creator-card").first()).toBeVisible();
});
