import { expect, test } from "@playwright/test";

test("real host streams the fake ACP workflow and replays it after reload", async ({ page }) => {
  test.setTimeout(60_000);

  await page.goto("/");
  await page.getByRole("button", { name: "New session" }).click();
  await page.getByLabel("Project").selectOption("e2e-project");
  await page.getByLabel("Runtime").selectOption("fake");
  await page.getByRole("button", { name: "Create session" }).click();

  await page.getByLabel("Message the agent").fill("inspect the first request");
  await page.getByRole("button", { name: "Send prompt" }).click();
  await expect(page.getByText("Fake response to: inspect the first request")).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Session activity" }).getByText("Read project status"),
  ).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Read project status" })).toBeVisible();
  await page.getByRole("button", { name: "Allow once" }).click();
  await expect(page.getByText("Turn completed")).toBeVisible();

  await page.reload();
  await expect(page.getByText("inspect the first request")).toBeVisible();
  await expect(page.getByText("Fake response to: inspect the first request")).toBeVisible();
  await expect(page.getByText("Turn completed")).toBeVisible();

  await page.getByLabel("Message the agent").fill("inspect the second request");
  await page.getByRole("button", { name: "Send prompt" }).click();
  await expect(page.getByText("Fake response to: inspect the second request")).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Read project status" })).toBeVisible();
  await page.getByRole("button", { name: "Allow once" }).click();
  await expect(page.getByText("Turn completed")).toHaveCount(2);
});

test("real host cancels a fake ACP turn while permission is pending", async ({ page }) => {
  test.setTimeout(45_000);

  await page.goto("/");
  await page.getByRole("button", { name: "New session" }).click();
  await page.getByLabel("Project").selectOption("e2e-project");
  await page.getByLabel("Runtime").selectOption("fake");
  await page.getByRole("button", { name: "Create session" }).click();
  await page.getByLabel("Message the agent").fill("cancel while permission is pending");
  await page.getByRole("button", { name: "Send prompt" }).click();

  await expect(page.getByRole("dialog", { name: "Read project status" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel this turn" }).click();
  await expect(page.getByText("Turn cancelled")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("dialog", { name: "Read project status" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Stop" })).toBeDisabled();
});

test("real host reports a crashed fake ACP process and clears the running turn", async ({
  page,
}) => {
  test.setTimeout(30_000);

  await page.goto("/");
  await page.getByRole("button", { name: "New session" }).click();
  await page.getByLabel("Project").selectOption("e2e-project");
  await page.getByLabel("Runtime").selectOption("fake");
  await page.getByRole("button", { name: "Create session" }).click();
  await page.getByLabel("Message the agent").fill("crash");
  await page.getByRole("button", { name: "Send prompt" }).click();

  const failureMessage = "The runtime could not complete the prompt.";
  await expect(page.getByText(failureMessage)).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("article.event-error")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Stop" })).toBeDisabled();
  await expect(page.getByText("failed", { exact: true })).toBeVisible();
});
