import { expect, test } from "@playwright/test";

test("programmable payments page explains discovery, primitives, and abuse coverage", async ({ page }) => {
  await page.goto("/agent/programmable-payments");

  await expect(page.getByRole("heading", { name: "Programmable Payments Command Center" })).toBeVisible();
  await expect(page.getByText("One money language for humans, agents, APIs, services, compute")).toBeVisible();
  await expect(page.getByText("GET /market/search?capability=gpu_compute")).toBeVisible();
  await expect(page.getByText("POST /commit to POST /finalize to GET paid result")).toBeVisible();

  await expect(page.getByRole("heading", { name: "What people can sell" })).toBeVisible();
  await expect(page.getByText("GPU / compute")).toBeVisible();
  await expect(page.getByText("physical_goods")).toBeVisible();
  await expect(page.getByText("copy_agent")).toBeVisible();

  await expect(page.getByRole("heading", { name: "Programmable payment primitives" })).toBeVisible();
  await expect(page.getByText("Fixed price", { exact: true })).toBeVisible();
  await expect(page.getByText("Streaming payments", { exact: true })).toBeVisible();
  await expect(page.getByText("Marketplace quotes", { exact: true })).toBeVisible();
  await expect(page.getByText("Anchoring", { exact: true })).toBeVisible();

  await expect(page.getByRole("heading", { name: "Cheat / attack angle matrix" })).toBeVisible();
  await expect(page.getByText("Replay / double spend")).toBeVisible();
  await expect(page.getByText("Underpay")).toBeVisible();
  await expect(page.getByText("Response swap")).toBeVisible();
  await expect(page.getByText("Malicious listing")).toBeVisible();
  await expect(page.getByText("Physical goods fraud")).toBeVisible();

  await expect(page.getByRole("heading", { name: "Local deploy target" })).toBeVisible();
  await expect(page.getByText("/market/search", { exact: true })).toBeVisible();
  await expect(page.getByText("/quote /commit /finalize /receipt", { exact: true })).toBeVisible();
});
