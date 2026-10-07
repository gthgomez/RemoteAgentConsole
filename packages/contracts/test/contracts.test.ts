import { describe, expect, it } from "vitest";
import {
  createSessionRequestSchema,
  eventEnvelopeSchema,
  permissionResponseRequestSchema,
  projectSummarySchema,
  promptRequestSchema,
  runtimeCapabilitiesSchema,
  runtimeSummarySchema,
} from "../src/index.js";

describe("contracts", () => {
  it("validates strict runtime and project catalogs without exposing paths", () => {
    const project = { id: "project-1", displayName: "My project" };
    expect(projectSummarySchema.parse(project)).toEqual(project);
    expect(projectSummarySchema.safeParse({ ...project, path: "/home/user/project" }).success).toBe(
      false,
    );

    const capabilities = {
      sessions: { create: true, resume: true, list: true },
      interaction: { cancel: true, permissions: true, questions: false },
      models: { selectable: true, effort: true },
      modes: true,
      plans: false,
      commands: true,
      images: false,
      files: true,
    };
    expect(runtimeCapabilitiesSchema.parse(capabilities)).toEqual(capabilities);
    expect(
      runtimeCapabilitiesSchema.safeParse({ ...capabilities, extraCapability: true }).success,
    ).toBe(false);
    expect(
      runtimeCapabilitiesSchema.safeParse({
        ...capabilities,
        sessions: { ...capabilities.sessions, arbitrary: true },
      }).success,
    ).toBe(false);

    expect(
      runtimeSummarySchema.parse({
        id: "fake",
        displayName: "Fake ACP",
        installed: true,
        version: "1.0.0",
        capabilities,
      }),
    ).toEqual({
      id: "fake",
      displayName: "Fake ACP",
      installed: true,
      version: "1.0.0",
      capabilities,
    });
    expect(
      runtimeSummarySchema.safeParse({
        id: "missing",
        displayName: "Missing runtime",
        installed: false,
        capabilities: null,
      }).success,
    ).toBe(true);
    expect(
      runtimeSummarySchema.safeParse({
        id: "fake",
        displayName: "Fake ACP",
        installed: true,
        capabilities,
        localPath: "/usr/bin/fake",
      }).success,
    ).toBe(false);
  });
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
