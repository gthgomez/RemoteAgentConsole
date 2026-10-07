import { describe, expect, it } from "vitest";
import {
  beginTurn,
  createSession,
  respondToPermission,
  setTurnStatus,
  transitionSession,
} from "../src/index.js";

describe("session domain", () => {
  it("allows legal transitions and rejects illegal ones", () => {
    const session = createSession({
      id: "s1",
      machineId: "m1",
      projectId: "p1",
      runtimeId: "fake",
    });
    expect(transitionSession(session, "idle").status).toBe("idle");
    expect(() => transitionSession(session, "running")).toThrow();
  });
  it("enforces one active turn", () => {
    const session = transitionSession(
      createSession({ id: "s1", machineId: "m1", projectId: "p1", runtimeId: "fake" }),
      "idle",
    );
    const active = beginTurn(session, { id: "t1", prompt: "hello" });
    expect(() => beginTurn(active, { id: "t2", prompt: "again" })).toThrow(/active turn/i);
  });
  it("does not restart completed sessions", () => {
    const idle = transitionSession(
      createSession({ id: "s2", machineId: "m1", projectId: "p1", runtimeId: "fake" }),
      "idle",
    );
    const completed = setTurnStatus(beginTurn(idle, { id: "t1", prompt: "hello" }), "completed");
    expect(completed.activeTurn).toBeNull();
    expect(() => beginTurn(completed, { id: "t2", prompt: "again" })).toThrow(/Cannot start turn/);
  });
  it("routes turn updates through legal session transitions", () => {
    const idle = transitionSession(
      createSession({ id: "s3", machineId: "m1", projectId: "p1", runtimeId: "fake" }),
      "idle",
    );
    const running = beginTurn(idle, { id: "t1", prompt: "hello" });
    expect(() => setTurnStatus({ ...running, status: "closed" }, "waiting_input")).toThrow(
      /Illegal session transition/,
    );
  });
  it("rejects overwrites of terminal turn states", () => {
    const idle = transitionSession(
      createSession({ id: "s4", machineId: "m1", projectId: "p1", runtimeId: "fake" }),
      "idle",
    );
    const completed = setTurnStatus(beginTurn(idle, { id: "t1", prompt: "hello" }), "completed");
    expect(() =>
      setTurnStatus(
        { ...completed, activeTurn: { id: "t1", prompt: "hello", status: "completed" } },
        "running",
      ),
    ).toThrow(/terminal turn/);
    const failed = setTurnStatus(beginTurn(idle, { id: "t2", prompt: "hello" }), "failed");
    expect(() =>
      setTurnStatus(
        { ...failed, activeTurn: { id: "t2", prompt: "hello", status: "failed" } },
        "completed",
      ),
    ).toThrow(/terminal turn/);
    const cancelled = setTurnStatus(beginTurn(idle, { id: "t3", prompt: "hello" }), "cancelled");
    expect(cancelled.activeTurn).toBeNull();
    expect(() =>
      setTurnStatus(
        { ...cancelled, activeTurn: { id: "t3", prompt: "hello", status: "cancelled" } },
        "running",
      ),
    ).toThrow(/terminal turn/);
  });
  it("rejects permission choices not offered by the runtime", () => {
    const result = respondToPermission(
      { permissionId: "perm1", options: [{ optionId: "allow", name: "Allow" }] },
      "deny",
    );
    expect(result).toEqual({ success: false });
    expect(
      respondToPermission(
        { permissionId: "perm1", options: [{ optionId: "allow", name: "Allow" }] },
        "allow",
      ),
    ).toEqual({ success: true, optionId: "allow" });
  });
});
