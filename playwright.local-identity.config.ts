import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: "local-identity.spec.ts",
  workers: 1,
  timeout: 120000,
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    channel: "chrome",
    baseURL: "https://localhost:3443",
    // This test trusts only its generated development certificate in the browser.
    // Backend OIDC and directory HTTPS still verify the explicit certificate.
    ignoreHTTPSErrors: true,
    trace: "off",
    screenshot: "off",
    video: "off",
  },
});
