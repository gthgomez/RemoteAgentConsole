import { expect, test } from "@playwright/test";

// A valid 32-byte base64url credential whose final alphabet index is 4.
const credential = `${"A".repeat(42)}E`;

function authRequired() {
  return { error: { code: "auth_required", message: "A paired device credential is required" } };
}

function requirePairingApi(page: import("@playwright/test").Page, invalidPairing = false) {
  const protectedRequests: string[] = [];
  let credentialAccepted = true;
  return {
    protectedRequests,
    rejectCredential: () => {
      credentialAccepted = false;
    },
    route: page.route("**/api/v1/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const auth = request.headers().authorization;
      if (url.pathname === "/api/v1/devices/pair" && request.method() === "POST") {
        expect(auth).toBeUndefined();
        expect(request.postDataJSON()).toMatchObject({ displayName: "Android phone" });
        if (invalidPairing || request.postDataJSON().code !== "QWER-TY23") {
          await route.fulfill({
            status: 401,
            json: {
              error: { code: "pairing_invalid", message: "Pairing code is invalid or expired" },
            },
          });
          return;
        }
        await route.fulfill({
          status: 201,
          json: {
            credential,
            device: {
              id: "device-1",
              displayName: "Android phone",
              createdAt: Date.now(),
              lastSeenAt: Date.now(),
              revokedAt: null,
            },
          },
        });
        return;
      }

      protectedRequests.push(`${request.method()} ${url.pathname} ${auth ?? ""}`);
      if (auth !== `Bearer ${credential}` || !credentialAccepted) {
        await route.fulfill({ status: 401, json: authRequired() });
      } else if (url.pathname === "/api/v1/projects") {
        await route.fulfill({ json: { projects: [] } });
      } else if (url.pathname === "/api/v1/runtimes") {
        await route.fulfill({ json: { runtimes: [] } });
      } else if (url.pathname === "/api/v1/sessions") {
        await route.fulfill({ json: { sessions: [] } });
      } else {
        await route.fulfill({ json: { accepted: true } });
      }
    }),
  };
}

async function readStoredCredential(page: import("@playwright/test").Page) {
  return page.evaluate(
    () =>
      new Promise<string | null>((resolve, reject) => {
        const request = indexedDB.open("rac-device-credentials", 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const database = request.result;
          if (!database.objectStoreNames.contains("credentials")) {
            database.close();
            resolve(null);
            return;
          }
          const transaction = database.transaction("credentials", "readonly");
          const get = transaction.objectStore("credentials").get("device");
          get.onerror = () => reject(get.error);
          get.onsuccess = () => {
            database.close();
            resolve(typeof get.result === "string" ? get.result : null);
          };
        };
      }),
  );
}

test("pairs a device, stores its credential, and restores it after reload", async ({ page }) => {
  const { protectedRequests, rejectCredential } = requirePairingApi(page);
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Connect this device" })).toBeVisible();
  await page.getByLabel("Pairing code").fill("QWER-TY23");
  await page.getByLabel("Device name").fill("Android phone");
  await page.getByRole("button", { name: "Pair device" }).click();
  await expect(page.getByRole("heading", { name: "Your sessions" })).toBeVisible();

  expect(await readStoredCredential(page)).toBe(credential);
  expect(protectedRequests.some((request) => request.endsWith(`Bearer ${credential}`))).toBe(true);

  await page.reload();
  await expect(page.getByRole("heading", { name: "Your sessions" })).toBeVisible();
  expect(await readStoredCredential(page)).toBe(credential);
  expect(
    protectedRequests.filter((request) => request.endsWith(`Bearer ${credential}`)).length,
  ).toBeGreaterThan(3);

  rejectCredential();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Connect this device" })).toBeVisible();
  expect(await readStoredCredential(page)).toBeNull();
});

test("shows an invalid pairing code without saving a credential", async ({ page }) => {
  requirePairingApi(page, true);
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Connect this device" })).toBeVisible();
  await page.getByLabel("Pairing code").fill("BAD-CODE");
  await page.getByLabel("Device name").fill("Android phone");
  await page.getByRole("button", { name: "Pair device" }).click();

  await expect(page.getByRole("alert")).toHaveText("Pairing code is invalid or expired");
  expect(await readStoredCredential(page)).toBeNull();
});
