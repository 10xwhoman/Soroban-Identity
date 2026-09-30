import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { installFreighter, stubSorobanRpc, TESTNET_PASSPHRASE } from "./freighter";

test.beforeEach(async ({ page }) => {
  await stubSorobanRpc(page);
});

test("connects a mocked Freighter wallet and shows the account", async ({ page }) => {
  await installFreighter(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Connect Freighter wallet" }).click();
  await page.getByRole("button", { name: "Freighter" }).click();
  await expect(page.getByText("via Freighter")).toBeVisible();
  await expect(page.getByRole("button", { name: /Wallet account GA7Q/ })).toBeVisible();
});

test("connected shell matches the chromium screenshot", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "screenshot baseline is captured on chromium");
  await installFreighter(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Connect Freighter wallet" }).click();
  await page.getByRole("button", { name: "Freighter" }).click();
  await expect(page.getByText("via Freighter")).toBeVisible();
  await expect(page).toHaveScreenshot("wallet-connected.png", {
    maxDiffPixelRatio: 0.03,
    fullPage: true,
  });
});

test("missing Freighter surfaces an install error", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Connect Freighter wallet" }).click();
  await page.getByRole("button", { name: "Freighter" }).click();
  await expect(page.getByRole("status")).toContainText("Freighter wallet extension not found");
});

test("wrong Freighter network is rejected", async ({ page }) => {
  await installFreighter(page, { passphrase: "Public Global Stellar Network ; September 2015" });
  await page.goto("/");
  await page.getByRole("button", { name: "Connect Freighter wallet" }).click();
  await page.getByRole("button", { name: "Freighter" }).click();
  await expect(page.getByRole("status")).toContainText("wrong network");
  expect(TESTNET_PASSPHRASE).toContain("Test SDF");
});

test("DID creation reports the RPC failure instead of a fake success", async ({ page }) => {
  await installFreighter(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Connect Freighter wallet" }).click();
  await page.getByRole("button", { name: "Freighter" }).click();
  await expect(page.getByRole("heading", { name: "Create DID" })).toBeVisible();
  await page.getByRole("button", { name: "Create DID" }).click();
  await expect(page.getByText(/Error:/)).toBeVisible();
});

test("credential tab exposes issue, verify, and revoke, and verify fails closed", async ({ page }) => {
  await installFreighter(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Connect Freighter wallet" }).click();
  await page.getByRole("button", { name: "Freighter" }).click();
  await page.locator("#tab-credentials").click();
  await expect(page.getByRole("heading", { name: "Verify Credential" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Issue Credential" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Revoke Credential" })).toBeVisible();

  await page.getByLabel("Credential ID to verify").fill("00".repeat(32));
  await page.getByRole("button", { name: "Verify", exact: true }).click();
  await expect(page.locator(".badge-red, .badge-yellow").first()).toBeVisible();
});

test("home has no critical axe violations", async ({ page }) => {
  await page.goto("/");
  const results = await new AxeBuilder({ page }).analyze();
  const blocking = results.violations.filter((v) => v.impact === "critical" || v.impact === "serious");
  expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
});
