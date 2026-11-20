import { defineConfig, devices } from "@playwright/test";

// E2E runs against a real Supabase staging project. Set E2E_BASE_URL (deployed or `npm run dev`)
// plus the synthetic accounts in e2e/README.md. Without credentials, only the public-page tests run.
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  use: { baseURL: process.env.E2E_BASE_URL ?? "http://localhost:5173", trace: "retain-on-failure" },
  projects: [
    { name: "phone-320", use: { ...devices["Pixel 5"], viewport: { width: 320, height: 640 } } },
    { name: "phone-390", use: { ...devices["iPhone 13"], defaultBrowserType: "chromium" } },
    { name: "tablet-768", use: { viewport: { width: 768, height: 1024 } } },
    { name: "laptop-1024", use: { viewport: { width: 1024, height: 768 } } },
    { name: "desktop-1440", use: { viewport: { width: 1440, height: 900 } } },
  ],
});
