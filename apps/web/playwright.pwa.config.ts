import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const workspaceRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  testDir: "./e2e",
  testMatch: "pwa.spec.ts",
  fullyParallel: true,
  reporter: "list",
  use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:4174" },
  webServer: {
    command:
      "pnpm --filter @remote-agent-console/web build && pnpm --filter @remote-agent-console/web exec vite preview --host 127.0.0.1 --port 4174",
    cwd: workspaceRoot,
    url: "http://127.0.0.1:4174",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
