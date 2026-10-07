import { describe, expect, it } from "vitest";
import {
  createSessionRequestSchema,
  eventEnvelopeSchema,
  permissionResponseRequestSchema,
  promptRequestSchema,
} from "../src/index.js";

describe("contracts", () => {
  it("validates session and prompt requests", () => {
    expect(
      createSessionRequestSchema.safeParse({ projectId: "project-1", runtimeId: "fake" }).success,
    ).toBe(true);
    expect(promptRequestSchema.safeParse({ requestId: "req-1", text: "hello" }).success).toBe(true);
    expect(promptRequestSchema.safeParse({ requestId: "", text: "" }).success).toBe(false);
  });
  it("preserves permission option identifiers and runtime metadata exactly", () => {
    const optionId = " allow ";
    const optionName = " Allow with spaces ";
    const event = {
      eventId: "e2",
      sequence: 2,
      machineId: "m1",
      sessionId: "s1",
      timestamp: "2026-10-07T00:00:00.000Z",
      eventType: "permission.requested",
      payload: {
        turnId: "t1",
        permissionId: "p1",
        title: "Run command?",
        options: [{ optionId, name: optionName, vendor: { policy: "strict" } }],
      },
    };
    const parsed = eventEnvelopeSchema.parse(event);
    expect(parsed.eventType).toBe("permission.requested");
    if (parsed.eventType === "permission.requested")
      expect(parsed.payload.options[0]).toEqual(event.payload.options[0]);
    expect(
      permissionResponseRequestSchema.parse({ requestId: "r1", permissionId: "p1", optionId })
        .optionId,
    ).toBe(optionId);
    expect(
      permissionResponseRequestSchema.safeParse({
        requestId: "r1",
        permissionId: "p1",
        optionId: "   ",
      }).success,
    ).toBe(false);
    const blankName = {
      ...event,
      payload: { ...event.payload, options: [{ ...event.payload.options[0], name: "   " }] },
    };
    expect(eventEnvelopeSchema.safeParse(blankName).success).toBe(false);
  });
  it("validates typed event envelopes and ISO timestamps", () => {
    const event = {
      eventId: "e1",
      sequence: 1,
      machineId: "m1",
      sessionId: "s1",
      timestamp: "2026-10-07T00:00:00.000Z",
      eventType: "turn.completed",
      payload: { turnId: "t1" },
    };
    expect(eventEnvelopeSchema.safeParse(event).success).toBe(true);
    expect(eventEnvelopeSchema.safeParse({ ...event, sequence: 0 }).success).toBe(false);
    expect(eventEnvelopeSchema.safeParse({ ...event, timestamp: "yesterday" }).success).toBe(false);
  });
});
