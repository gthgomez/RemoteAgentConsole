import { createInterface } from "node:readline";

setInterval(() => {}, 60_000);
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    respond(request.id, {
      protocolVersion: request.params.protocolVersion,
      agentCapabilities: {},
    });
  } else if (request.method === "session/new") {
    if (process.argv[2] === "session-new") {
      process.stdout.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: -32000,
            message: `Failed opening ${process.cwd()}/private/runtime-config`,
          },
        })}\n`,
      );
    } else {
      respond(request.id, { sessionId: "protocol-error-session" });
    }
  } else if (request.method === "session/prompt") {
    process.stdout.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: -32000,
          message: `Failed reading ${process.cwd()}/private/runtime-config`,
        },
      })}\n`,
    );
  }
});

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}
