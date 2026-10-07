import { expect, test } from "@playwright/test";

test("installs an app shell that is available offline without caching API data", async ({
  page,
  context,
}) => {
  await page.goto("/");

  const manifest = await page.evaluate(async () => {
    const response = await fetch("/manifest.webmanifest");
    return (await response.json()) as {
      id?: string;
      scope?: string;
      start_url?: string;
      display?: string;
      icons?: Array<{ src: string; sizes: string; type: string }>;
    };
  });

  expect(manifest).toMatchObject({ id: "/", scope: "/", start_url: "/", display: "standalone" });
  expect(manifest.icons).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        src: "/icons/fieldwork-192.png",
        sizes: "192x192",
        type: "image/png",
      }),
      expect.objectContaining({
        src: "/icons/fieldwork-512.png",
        sizes: "512x512",
        type: "image/png",
      }),
    ]),
  );

  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.ready.then(() => true)))
    .toBe(true);
  await page.reload();
  await expect(page).toHaveTitle(/Fieldwork/);

  const cachedPaths = await page.evaluate(async () => {
    const names = await caches.keys();
    const requests = await Promise.all(names.map(async (name) => (await caches.open(name)).keys()));
    return requests.flat().map((request) => new URL(request.url).pathname);
  });
  expect(cachedPaths).toContain("/");
  expect(cachedPaths.some((path) => path.startsWith("/assets/") && path.endsWith(".js"))).toBe(
    true,
  );
  expect(cachedPaths.some((path) => path.startsWith("/api/"))).toBe(false);

  expect(await page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  await context.setOffline(true);
  await page.goto("/");
  await expect(page).toHaveTitle(/Fieldwork/);
  await expect(page.getByRole("heading", { name: /your sessions/i })).toBeVisible();
});
