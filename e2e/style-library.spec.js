// @ts-check
const { test, expect } = require("@playwright/test");

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

test("Style Library creates a style, renders its card, and opens portal details", async ({ page }) => {
  const token = process.env.VIVO_E2E_TOKEN;
  if (!token) throw new Error("VIVO_E2E_TOKEN not set — check global-setup.js");
  let styles = [];
  const user = {
    user_id: "e2e-admin",
    id: "e2e-admin",
    email: "e2e@vivofashiongroup.com",
    name: "E2E Admin",
    role: "admin",
    status: "active",
    active: true,
    allowed_pages: ["product-analysis", "style-library"],
  };

  // ProductAnalysis owns several background widgets unrelated to this flow.
  // Keep those isolated from the live API; endpoint-specific routes registered
  // below take precedence over this fallback.
  await page.route("**/api/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
  await page.route("**/api/auth/me**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(user) }));
  await page.route("**/api/style-library/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/facets")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          categories: [{ name: "Dresses", sub_categories: [{ name: "Maxi Dresses", count: styles.length }] }],
          fabrics: styles.length ? ["Linen"] : [],
          brands: ["Vivo", "Safari", "Zoya"],
          statuses: ["Active", "Retired"],
        }),
      });
    }
    if (url.pathname.endsWith("/search")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ items: styles, has_more: false, limit: 48, offset: 0 }),
      });
    }
    if (/\/image\/\d+$/.test(url.pathname)) {
      return route.fulfill({ status: 200, contentType: "image/png", body: PNG });
    }
    const match = url.pathname.match(/\/style-library\/(\d+)$/);
    if (match) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(styles.find((style) => style.id === Number(match[1]))),
      });
    }
    return route.continue();
  });
  await page.route("**/api/style-library", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const style = {
      id: 71,
      style_name: "Aster Dress",
      style_number: "AS-071",
      category: "Dresses",
      sub_category: "Maxi Dresses",
      fabric: "Linen",
      brand: "Vivo",
      status: "Active",
      launch_date: "2026-09-10",
      adoption_date: "2026-09-12",
      image_url: "/api/style-library/image/71",
    };
    styles = [style];
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(style),
    });
  });

  // The shell also loads notification/freshness endpoints. Use the temporary
  // session created by global setup so those requests cannot trigger the
  // global 401 interceptor while the Style Library endpoints remain mocked.
  await page.context().addCookies([
    { name: "session_token", value: token, url: "http://localhost:80" },
  ]);
  await page.goto("/product-analysis?tab=style-library");
  await expect(page.getByTestId("style-library-header")).toContainText("Style Library");
  await page.getByTestId("style-library-add").click();
  await page.getByTestId("add-style-style_name").fill("Aster Dress");
  await page.getByTestId("add-style-style_number").fill("AS-071");
  await page.getByTestId("add-style-fabric").fill("Linen");
  await page.getByTestId("add-style-category").selectOption("Tops");
  await page.getByTestId("add-style-sub-category").selectOption("Fitted Tops");
  await page.getByTestId("add-style-category").selectOption("Dresses");
  await expect(page.getByTestId("add-style-sub-category")).toHaveValue("");
  await page.getByTestId("add-style-sub-category").selectOption("Maxi Dresses");
  await page.getByTestId("add-style-launch-date").fill("2026-09-10");
  await page.getByTestId("add-style-adoption-date").fill("2026-09-12");
  await page.getByTestId("add-style-photo").setInputFiles({
    name: "aster.png",
    mimeType: "image/png",
    buffer: PNG,
  });
  await page.getByTestId("add-style-submit").click();

  const card = page.getByTestId("style-library-card-71");
  await expect(card).toContainText("Aster Dress");
  await expect(card).toContainText("AS-071");
  await card.click();
  await expect(page.getByTestId("style-library-detail-modal")).toBeVisible();
  await expect(page.getByTestId("style-library-detail-fields")).toContainText("Maxi Dresses");
  await expect(page.getByTestId("style-library-detail-fields")).toContainText("12 Sept 2026");
});