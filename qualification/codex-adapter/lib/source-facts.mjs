function lineOf(source, index) {
  return source.slice(0, index).split("\n").length;
}

function findAll(source, regex) {
  const matches = [];
  const global = regex.global ? regex : new RegExp(regex.source, `${regex.flags}g`);
  let match = global.exec(source);
  while (match) {
    matches.push({ index: match.index, line: lineOf(source, match.index), text: match[0] });
    match = global.exec(source);
  }
  return matches;
}

/** Returns the balanced `{...}` block that starts at or after `from`. */
function balancedBlock(source, from) {
  const brace = source.indexOf("{", from);
  if (brace < 0) return null;
  let depth = 0;
  for (let index = brace; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(brace, index + 1);
    }
  }
  return null;
}

function requestSlices(source, method) {
  return findAll(source, new RegExp(`client\\.request\\(\\s*'${method}'`, "g")).map((match) => {
    const block = balancedBlock(source, match.index);
    return { line: match.line, block: block ?? "" };
  });
}

/** Structural facts required by the qualification, tied to the pinned source. */
export function analyzeRuntimeSource(source) {
  const rollbackCalls = requestSlices(source, "thread/rollback");
  const revertCalls = requestSlices(source, "thread/revert");
  const interruptCalls = requestSlices(source, "turn/interrupt");
  const cancelMarker = "cancel: async () => {";
  const cancelIndex = source.indexOf(cancelMarker);
  const cancelBlock = cancelIndex >= 0 ? balancedBlock(source, cancelIndex) : null;
  const terminalSettleCalls = findAll(source, /settleTerminalPendingTurn\(/g);
  const matchDefinitionIndex = source.indexOf("const terminalNotificationMatchesPendingTurn = (");
  const matchDefinitionBlock =
    matchDefinitionIndex >= 0 ? balancedBlock(source, matchDefinitionIndex) : null;
  const outcomeDefinitionIndex = source.indexOf("function readCodexTerminalOutcome(");
  const outcomeBlock =
    outcomeDefinitionIndex >= 0
      ? source.slice(outcomeDefinitionIndex, outcomeDefinitionIndex + 1200)
      : "";

  return {
    rollback: {
      count: rollbackCalls.length,
      shapes: rollbackCalls.map((call) => ({
        line: call.line,
        hasThreadId: /threadId\s*:/.test(call.block),
        hasNumTurns: /numTurns\s*:/.test(call.block),
      })),
    },
    revert: {
      count: revertCalls.length,
      shapes: revertCalls.map((call) => ({
        line: call.line,
        hasThreadId: /threadId\s*:/.test(call.block),
        hasBeforeTurnId: /beforeTurnId\s*:/.test(call.block),
      })),
    },
    interrupt: {
      count: interruptCalls.length,
      shapes: interruptCalls.map((call) => ({
        line: call.line,
        hasThreadId: /threadId\s*:/.test(call.block),
        hasTurnId: /turnId\s*:/.test(call.block),
      })),
    },
    cancel: {
      found: Boolean(cancelBlock),
      requestsInterrupt: Boolean(
        cancelBlock?.includes("requestCodexTurnInterruptWithStartupRetry"),
      ),
      awaitsTerminalAfterInterrupt: Boolean(cancelBlock?.includes("await activeTurn.promise")),
      settlesOptimistically: Boolean(cancelBlock?.includes("finishPendingTurn")),
    },
    terminal: {
      handlers: findAll(source, /registerTerminalHandler\('([^']+)'\)/g).map((match) => match.text),
      settlementCallCount: terminalSettleCalls.length,
      identityDefinitionFound: Boolean(matchDefinitionBlock),
      identityComparesTrackedTurnId: Boolean(
        matchDefinitionBlock?.includes("activeTurn.turnId === terminalTurnId"),
      ),
      outcomeClassifiesCompatibilityNotification: outcomeBlock.includes(
        "if (method !== 'turn/completed') return 'interrupted';",
      ),
      outcomeClassifiesInterruptedStatus: outcomeBlock.includes(
        "isCodexTurnInterruptedStatus(status) ? 'interrupted' : 'completed'",
      ),
    },
    rollbackUnsupportedHandling: {
      mapsMethodNotFound: source.includes("readRollbackUnsupportedErrorMessage"),
      returnsUnsupportedAction: source.includes("errorCode: 'unsupported_action'"),
    },
  };
}

export function analyzeHistoryBoundarySource(source) {
  return {
    terminalMethods: findAll(source, /notification\.method === '([^']+)'/g).map(
      (match) => match.text,
    ),
    includesCompleted: source.includes("'turn/completed'"),
    includesInterrupted: source.includes("'turn/interrupted'"),
  };
}

export { findAll, lineOf };
