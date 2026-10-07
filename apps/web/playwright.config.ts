import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const workspaceRoot = fileURLToPath(new URL("../..", import.meta.url));
const hostDatabasePath = join(tmpdir(), `remote-agent-console-e2e-${process.pid}.sqlite`);
const projectAllowlist = JSON.stringify([
  { id: "e2e-project", displayName: "Local repository", path: workspaceRoot },
]);

export default defineConfig({
  testDir: "./e2e",
  testIgnore: "pwa.spec.ts",
  fullyParallel: true,
  reporter: "list",
  use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:4173" },
  webServer: [
    {
      command: "pnpm --filter @remote-agent-console/host dev:test",
      cwd: workspaceRoot,
      url: "http://127.0.0.1:4318/api/v1/health",
      env: {
        RAC_HOST_PORT: "4318",
        RAC_PROJECTS_JSON: projectAllowlist,
        RAC_HOST_DATABASE_PATH: hostDatabasePath,
      },
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: "pnpm --filter @remote-agent-console/web exec vite --host 127.0.0.1 --port 4173",
      cwd: workspaceRoot,
      url: "http://127.0.0.1:4173",
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
