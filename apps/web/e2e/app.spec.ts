import { expect, test, type Page } from "@playwright/test";

const ADMIN = { email: process.env.E2E_ADMIN_EMAIL, password: process.env.E2E_ADMIN_PASSWORD };
const STAFF = { email: process.env.E2E_STAFF_EMAIL, password: process.env.E2E_STAFF_PASSWORD, name: process.env.E2E_STAFF_NAME };
const STAFF2 = { email: process.env.E2E_STAFF2_EMAIL, password: process.env.E2E_STAFF2_PASSWORD };
const hasCreds = !!(ADMIN.email && STAFF.email && STAFF2.email && STAFF.name);

async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, "page-wide horizontal scroll").toBeLessThanOrEqual(1);
}

async function login(page: Page, who: { email?: string; password?: string }) {
  await page.goto("/login");
  await page.getByLabel("Work email").fill(who.email!);
  await page.getByLabel("Password").fill(who.password!);
  await page.getByRole("button", { name: "Sign in" }).click();
}

test("anonymous user is sent to login for every protected page", async ({ page }) => {
  for (const path of ["/admin", "/admin/farmers", "/staff", "/admin/tracking"]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/login$/);
  }
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await noHorizontalOverflow(page);
});

test.describe("authenticated flows (staging)", () => {
  test.skip(!hasCreds, "Set E2E_* credentials for a staging project with synthetic users");

  test("admin creates product, farmer, pin and visit; only the assigned staff member can open it", async ({ page, browser }) => {
    const stamp = Date.now();
    await login(page, ADMIN);
    await expect(page).toHaveURL(/\/admin/);
    await noHorizontalOverflow(page);

    await page.goto("/admin/products");
    await page.getByRole("button", { name: "+ Add product" }).click();
    await page.getByLabel("SKU / code").fill(`E2E-${stamp}`);
    await page.getByLabel("Name").fill(`E2E product ${stamp}`);
    await page.getByLabel("Pack / unit").fill("kg");
    await page.getByLabel("Price ₹ (optional)").fill("100");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText(`E2E product ${stamp}`)).toBeVisible();

    await page.goto("/admin/farmers");
    await page.getByRole("button", { name: "+ Add farmer" }).click();
    await page.getByLabel("Full name").fill(`E2E Farmer ${stamp}`);
    await page.getByLabel("Village").fill("E2E Village");
    await page.getByRole("button", { name: /^Save/ }).click();
    await expect(page.getByRole("heading", { name: `E2E Farmer ${stamp}` })).toBeVisible();
    await page.locator(".leaflet-container").first().click({ position: { x: 150, y: 150 } });
    await page.getByRole("button", { name: "Confirm pin" }).click();
    await expect(page.getByText(/Confirmed/)).toBeVisible();

    await page.getByRole("button", { name: "+ Assign visit" }).click();
    const staffSelect = page.getByLabel("Assign to");
    const value = await staffSelect.locator("option", { hasText: STAFF.name! }).first().getAttribute("value");
    await staffSelect.selectOption(value!);
    await page.getByRole("button", { name: "Assign visit" }).last().click();
    await expect(page).toHaveURL(/\/admin\/visits\/[0-9a-f-]{36}$/);
    const visitId = page.url().split("/").pop()!;

    const staffCtx = await browser.newContext();
    const sp = await staffCtx.newPage();
    await login(sp, STAFF);
    await sp.goto(`/staff/visits/${visitId}`);
    await expect(sp.getByRole("heading", { name: `E2E Farmer ${stamp}` })).toBeVisible();
    await expect(sp.getByRole("link", { name: /Get directions/ })).toHaveAttribute("href", /google\.com\/maps\/dir\/\?api=1&destination=/);
    await noHorizontalOverflow(sp);

    const otherCtx = await browser.newContext();
    const op = await otherCtx.newPage();
    await login(op, STAFF2);
    await op.goto(`/staff/visits/${visitId}`);
    await expect(op.getByText(/no longer have access/)).toBeVisible();
  });
});
