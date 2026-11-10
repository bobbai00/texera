import { expect, test } from "@playwright/test";

// The sign-in page says what it cannot do. A browser lets a page sign in only at a secure
// address (https, or localhost): the exchange with the identity provider needs Web Crypto, which
// it keeps from any other page. A deployment reached over plain http used to offer a button that
// went grey for good; now the page says so, and a sign-in that does not start gives the button
// back with the reason.

test("at an address that is not secure the page says it cannot sign in, and offers no button", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window, "isSecureContext", { value: false }));
  await page.goto("/login");
  await expect(page.locator("[data-sign-in-refused]")).toContainText("not secure");
  await expect(page.locator("[data-sign-in]")).toHaveCount(0);
});

test("a sign-in that does not start says why and can be tried again", async ({ page }) => {
  // What the exchange needs is taken away, as a browser does at an address it does not trust.
  await page.addInitScript(() => Object.defineProperty(crypto, "subtle", { value: undefined }));
  await page.goto("/login");
  const button = page.locator("[data-sign-in]");
  await button.click();
  await expect(page.locator("[data-sign-in-failed]")).toContainText("Signing in did not start");
  await expect(button).toBeEnabled();
});

test("at a secure address the button takes the person to the sign-in form", async ({ page }) => {
  await page.goto("/login");
  await page.locator("[data-sign-in]").click();
  await expect(page.locator("#username")).toBeVisible();
});
