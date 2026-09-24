import { defineConfig } from "@playwright/test";
import identity from "./playwright.local-identity.config";

export default defineConfig({
  ...identity,
  testMatch: "local-runtime.spec.ts",
  timeout: 180000,
  expect: { timeout: 15000 },
});
