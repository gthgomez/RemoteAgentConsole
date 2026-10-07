import { createHostApp } from "./index.js";

const app = createHostApp({
  machineId: process.env.RAC_MACHINE_ID ?? "local-machine",
  projects: [],
  supervisor: {
    runtimes: () => [],
    createSession: async () => {
      throw new Error("No runtime supervisor is configured");
    },
  },
});

const portValue = Number(process.env.RAC_HOST_PORT ?? "4318");
if (!Number.isInteger(portValue) || portValue < 1 || portValue > 65535) {
  throw new Error("RAC_HOST_PORT must be an integer from 1 to 65535");
}
await app.listen({ host: "127.0.0.1", port: portValue });
