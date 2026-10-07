import { expect, test } from "@playwright/test";
import type { EventEnvelope } from "@remote-agent-console/contracts";

test("creates a session, streams activity, responds to permission, and restores it after refresh", async ({
  page,
}) => {
  const events: unknown[] = [];
  let permissionResolved = false;
  let sessionExists = false;
  let promptSubmitted = false;

  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path === "/api/v1/projects") {
      await route.fulfill({
        json: { projects: [{ id: "project-1", displayName: "Field Notes" }] },
      });
    } else if (path === "/api/v1/runtimes") {
      await route.fulfill({
        json: {
          runtimes: [
            {
              id: "runtime-a",
              displayName: "Local Agent",
              installed: true,
              capabilities: {
                sessions: { create: true, resume: true, list: true },
                interaction: { cancel: true, permissions: true, questions: false },
                models: { selectable: true, effort: true },
                modes: true,
                plans: true,
                commands: false,
                images: false,
                files: true,
              },
            },
          ],
        },
      });
    } else if (path === "/api/v1/sessions" && request.method() === "GET") {
      await route.fulfill({
        json: {
          sessions: sessionExists
            ? [
                {
                  id: "session-1",
                  machineId: "machine",
                  projectId: "project-1",
                  runtimeId: "runtime-a",
                  status: permissionResolved ? "completed" : "waiting_permission",
                  createdAt: new Date().toISOString(),
                  updatedAt: new Date().toISOString(),
                  activeTurnId: null,
                },
              ]
            : [],
        },
      });
    } else if (path === "/api/v1/sessions" && request.method() === "POST") {
      const createBody = request.postDataJSON() as Record<string, unknown>;
      expect(createBody).toMatchObject({ projectId: "project-1", runtimeId: "runtime-a" });
      expect(createBody.requestId).toEqual(expect.any(String));
      sessionExists = true;
      await route.fulfill({
        json: {
          session: {
            id: "session-1",
            machineId: "machine",
            projectId: "project-1",
            runtimeId: "runtime-a",
            status: "idle",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            activeTurnId: null,
          },
        },
      });
    } else if (path === "/api/v1/sessions/session-1") {
      await route.fulfill({
        json: {
          session: {
            id: "session-1",
            machineId: "machine",
            projectId: "project-1",
            runtimeId: "runtime-a",
            status: permissionResolved ? "completed" : "waiting_permission",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            activeTurnId: null,
          },
        },
      });
    } else if (path.endsWith("/prompts")) {
      promptSubmitted = true;
      await route.fulfill({ json: { accepted: true, requestId: "prompt-1", turnId: "turn-1" } });
    } else if (path.endsWith("/respond")) {
      permissionResolved = true;
      await route.fulfill({ json: { accepted: true, requestId: "permission-1" } });
    } else if (path.endsWith("/events")) {
      if (!promptSubmitted) {
        await route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          body: ": waiting\n\n",
        });
        return;
      }
      const body: EventEnvelope[] = [
        {
          eventId: "e1",
          sequence: 1,
          machineId: "machine",
          sessionId: "session-1",
          timestamp: new Date().toISOString(),
          eventType: "turn.started",
          payload: { turnId: "turn-1" },
        },
        {
          eventId: "e2",
          sequence: 2,
          machineId: "machine",
          sessionId: "session-1",
          timestamp: new Date().toISOString(),
          eventType: "message.delta",
          payload: { turnId: "turn-1", text: "I will inspect the project." },
        },
        {
          eventId: "e3",
          sequence: 3,
          machineId: "machine",
          sessionId: "session-1",
          timestamp: new Date().toISOString(),
          eventType: "tool.updated",
          payload: {
            turnId: "turn-1",
            toolCallId: "tool-1",
            title: "Read project files",
            status: "completed",
          },
        },
        {
          eventId: "e4",
          sequence: 4,
          machineId: "machine",
          sessionId: "session-1",
          timestamp: new Date().toISOString(),
          eventType: "permission.requested",
          payload: {
            turnId: "turn-1",
            permissionId: "permission-1",
            title: "Allow file changes?",
            options: [
              { optionId: "once", name: "Allow once" },
              { optionId: "deny", name: "Deny" },
            ],
          },
        },
        ...(permissionResolved
          ? [
              {
                eventId: "e5",
                sequence: 5,
                machineId: "machine",
                sessionId: "session-1",
                timestamp: new Date().toISOString(),
                eventType: "turn.completed",
                payload: { turnId: "turn-1" },
              } satisfies EventEnvelope,
            ]
          : []),
      ];
      events.push(...body);
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: body
          .map((event) => `id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`)
          .join(""),
      });
    } else {
      await route.fulfill({ json: { accepted: true } });
    }
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Your sessions" })).toBeVisible();
  await page.getByRole("button", { name: "New session" }).click();
  await page.getByLabel("Project").selectOption("project-1");
  await page.getByLabel("Runtime").selectOption("runtime-a");
  await page.getByRole("button", { name: "Create session" }).click();
  const composer = page.getByLabel("Message the agent");
  await composer.click();
  await composer.pressSequentially("Review this project");
  await expect(composer).toHaveValue("Review this project");
  await expect(composer).toBeFocused();
  await page.getByRole("button", { name: "Send prompt" }).click();
  await expect(page.getByText("I will inspect the project.")).toBeVisible();
  await expect(page.getByText("Read project files")).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Allow file changes?" })).toBeVisible();
  const allowOnce = page.getByRole("button", { name: "Allow once" });
  await expect(allowOnce).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByRole("button", { name: "Cancel this turn" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(allowOnce).toBeFocused();
  await allowOnce.click();
  await expect(page.getByText("Turn completed")).toBeVisible();
  await page.reload();
  await expect(page.getByText("Review this project")).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(events.length).toBeGreaterThan(0);
});

test("shows reconnect state when the event stream disconnects", async ({ page }) => {
  await page.route("**/api/v1/projects", (route) => route.fulfill({ json: { projects: [] } }));
  await page.route("**/api/v1/runtimes", (route) => route.fulfill({ json: { runtimes: [] } }));
  await page.route("**/api/v1/sessions", (route) =>
    route.fulfill({
      json: {
        sessions: [
          {
            id: "session-1",
            machineId: "machine",
            projectId: "p",
            runtimeId: "r",
            status: "running",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            activeTurnId: "turn-1",
            projectDisplayName: "Project",
          },
        ],
      },
    }),
  );
  await page.route("**/api/v1/sessions/session-1", (route) =>
    route.fulfill({
      json: {
        session: {
          id: "session-1",
          machineId: "machine",
          projectId: "p",
          runtimeId: "r",
          status: "running",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          activeTurnId: "turn-1",
        },
      },
    }),
  );
  await page.route("**/api/v1/sessions/session-1/events", (route) => route.abort());
  await page.goto("/sessions/session-1");
  await expect(page.getByText("Reconnecting to session…")).toBeVisible();
});

test("cancels a turn from the permission sheet and clears the pending request", async ({
  page,
}) => {
  let cancelReceived = false;
  const now = new Date().toISOString();
  const events: EventEnvelope[] = [
    {
      eventId: "cancel-start",
      sequence: 1,
      machineId: "machine",
      sessionId: "session-cancel",
      timestamp: now,
      eventType: "turn.started",
      payload: { turnId: "turn-cancel" },
    },
    {
      eventId: "cancel-permission",
      sequence: 2,
      machineId: "machine",
      sessionId: "session-cancel",
      timestamp: now,
      eventType: "permission.requested",
      payload: {
        turnId: "turn-cancel",
        permissionId: "permission-cancel",
        title: "Allow this action?",
        options: [{ optionId: "allow-once", name: "Allow once" }],
      },
    },
  ];

  await page.route("**/api/v1/projects", (route) => route.fulfill({ json: { projects: [] } }));
  await page.route("**/api/v1/runtimes", (route) => route.fulfill({ json: { runtimes: [] } }));
  await page.route("**/api/v1/sessions", (route) =>
    route.fulfill({
      json: {
        sessions: [
          {
            id: "session-cancel",
            machineId: "machine",
            projectId: "p",
            runtimeId: "r",
            status: "waiting_permission",
            createdAt: now,
            updatedAt: now,
            activeTurnId: "turn-cancel",
            projectDisplayName: "Project",
          },
        ],
      },
    }),
  );
  await page.route("**/api/v1/sessions/session-cancel", (route) =>
    route.fulfill({
      json: {
        session: {
          id: "session-cancel",
          machineId: "machine",
          projectId: "p",
          runtimeId: "r",
          status: "waiting_permission",
          createdAt: now,
          updatedAt: now,
          activeTurnId: "turn-cancel",
        },
      },
    }),
  );
  await page.route("**/api/v1/sessions/session-cancel/cancel", async (route) => {
    cancelReceived = true;
    await route.fulfill({ json: { accepted: true, requestId: "cancel-request" } });
  });
  await page.route("**/api/v1/sessions/session-cancel/events", async (route) => {
    const delivery = cancelReceived
      ? [
          ...events,
          {
            eventId: "cancelled",
            sequence: 3,
            machineId: "machine",
            sessionId: "session-cancel",
            timestamp: now,
            eventType: "turn.failed",
            payload: { turnId: "turn-cancel", message: "Cancelled by user" },
          } satisfies EventEnvelope,
        ]
      : events;
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: delivery
        .map((event) => `id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`)
        .join(""),
    });
  });

  await page.goto("/sessions/session-cancel");
  await expect(page.getByRole("dialog", { name: "Allow this action?" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel this turn" }).click();
  await expect.poll(() => cancelReceived).toBe(true);
  await expect(page.getByText("Cancelled by user")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("dialog", { name: "Allow this action?" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Stop" })).toBeDisabled();
});

test("shows session errors and clears the active turn", async ({ page }) => {
  const now = new Date().toISOString();
  const event: EventEnvelope = {
    eventId: "session-error-1",
    sequence: 2,
    machineId: "machine",
    sessionId: "session-error",
    timestamp: now,
    eventType: "session.error",
    payload: { message: "Agent process exited unexpectedly" },
  };
  await page.route("**/api/v1/projects", (route) => route.fulfill({ json: { projects: [] } }));
  await page.route("**/api/v1/runtimes", (route) => route.fulfill({ json: { runtimes: [] } }));
  await page.route("**/api/v1/sessions", (route) =>
    route.fulfill({
      json: {
        sessions: [
          {
            id: "session-error",
            machineId: "machine",
            projectId: "p",
            runtimeId: "r",
            status: "running",
            createdAt: now,
            updatedAt: now,
            activeTurnId: "turn-error",
            projectDisplayName: "Project",
          },
        ],
      },
    }),
  );
  await page.route("**/api/v1/sessions/session-error", (route) =>
    route.fulfill({
      json: {
        session: {
          id: "session-error",
          machineId: "machine",
          projectId: "p",
          runtimeId: "r",
          status: "running",
          createdAt: now,
          updatedAt: now,
          activeTurnId: "turn-error",
        },
      },
    }),
  );
  await page.route("**/api/v1/sessions/session-error/events", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: `id: 2\ndata: ${JSON.stringify(event)}\n\n`,
    }),
  );

  await page.goto("/sessions/session-error");
  await expect(page.getByText("Agent process exited unexpectedly")).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop" })).toBeDisabled();
  await expect(page.getByText("failed", { exact: true })).toBeVisible();
});
