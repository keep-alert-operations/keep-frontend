import { defineConfig } from "@playwright/test";
import identity from "./playwright.local-identity.config";

// Smoke S3 browser step; opt in with KEEP_LOCAL_V2_BROWSER_TEST=1.
export default defineConfig({
  ...identity,
  testMatch: "local-v2-browser.spec.ts",
  timeout: 180000,
  expect: { timeout: 15000 },
});
