import { expect, test } from "@playwright/test";

const credential = "A".repeat(43);

test("authenticates the event stream and resumes from Last-Event-ID", async ({ page }) => {
  const eventRequests: Array<{
    authorization: string | undefined;
    cursor: string | undefined;
    search: string;
  }> = [];
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const authorization = request.headers().authorization;
    if (url.pathname === "/api/v1/devices/pair") {
      await route.fulfill({
        status: 201,
        json: {
          credential,
          device: { id: "device-2", displayName: "Android phone" },
        },
      });
      return;
    }
    if (authorization !== `Bearer ${credential}`) {
      await route.fulfill({
        status: 401,
        json: {
          error: { code: "auth_required", message: "A paired device credential is required" },
        },
      });
      return;
    }
    if (url.pathname === "/api/v1/projects") {
      await route.fulfill({
        json: { projects: [{ id: "project-1", displayName: "Field Notes" }] },
      });
    } else if (url.pathname === "/api/v1/runtimes") {
      await route.fulfill({ json: { runtimes: [] } });
    } else if (url.pathname === "/api/v1/sessions" && request.method() === "GET") {
      await route.fulfill({
        json: {
          sessions: [
            {
              id: "session-1",
              machineId: "machine",
              projectId: "project-1",
              runtimeId: "runtime",
              status: "idle",
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              activeTurnId: null,
              projectDisplayName: "Field Notes",
            },
          ],
        },
      });
    } else if (url.pathname === "/api/v1/sessions/session-1") {
      await route.fulfill({
        json: {
          session: {
            id: "session-1",
            machineId: "machine",
            projectId: "project-1",
            runtimeId: "runtime",
            status: "idle",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            activeTurnId: null,
          },
        },
      });
    } else if (url.pathname === "/api/v1/sessions/session-1/events") {
      eventRequests.push({
        authorization,
        cursor: request.headers()["last-event-id"],
        search: url.search,
      });
      if (eventRequests.length > 2) {
        await route.fulfill({
          status: 401,
          json: { error: { code: "auth_required", message: "Device revoked" } },
        });
        return;
      }
      const body =
        eventRequests.length === 1
          ? `id: 1\ndata: ${JSON.stringify({
              eventId: "event-1",
              sequence: 1,
              machineId: "machine",
              sessionId: "session-1",
              timestamp: new Date().toISOString(),
              eventType: "session.status_changed",
              payload: { status: "idle" },
            })}\n\n`
          : ": waiting\n\n";
      await route.fulfill({ status: 200, contentType: "text/event-stream", body });
    } else {
      await route.fulfill({ json: { accepted: true } });
    }
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Connect this device" })).toBeVisible();
  await page.getByLabel("Pairing code").fill("QWER-TY23");
  await page.getByLabel("Device name").fill("Android phone");
  await page.getByRole("button", { name: "Pair device" }).click();
  await expect(page.getByRole("heading", { name: "Your sessions" })).toBeVisible();
  await page.getByRole("button", { name: /Field Notes/ }).click();
  await expect(page.getByRole("heading", { name: "Field Notes" })).toBeVisible();
  await expect.poll(() => eventRequests.length).toBeGreaterThan(1);
  expect(eventRequests[0]).toMatchObject({ authorization: `Bearer ${credential}`, search: "" });
  expect(eventRequests[1]).toMatchObject({
    authorization: `Bearer ${credential}`,
    cursor: "1",
    search: "",
  });
  await expect(page.getByRole("heading", { name: "Connect this device" })).toBeVisible();
});
