import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const app = acp.agent({ name: "crash-agent" });
app.onRequest("initialize", ({ params }) => ({
  protocolVersion: params.protocolVersion,
  agentCapabilities: { sessionCapabilities: { list: {}, resume: {} } },
}));
app.onRequest("session/new", () => {
  setTimeout(() => process.exit(23), 100);
  return { sessionId: "crash-session" };
});
app.connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
