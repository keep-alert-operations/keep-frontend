import { defineConfig } from "@playwright/test";
import identity from "./playwright.local-identity.config";

// Smoke S4 incident lifecycle; opt in with KEEP_LOCAL_INCIDENT_TEST=1.
export default defineConfig({
  ...identity,
  testMatch: "local-incident.spec.ts",
  timeout: 180000,
  expect: { timeout: 15000 },
});
