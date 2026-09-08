import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const artifactRoot = resolve(import.meta.dirname, "../..");

describe("PWA base-path compatibility", () => {
  it("keeps manifest navigation and icons relative to its mount path", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(artifactRoot, "public/manifest.webmanifest"), "utf8"),
    );

    expect(manifest.id).toBe("./");
    expect(manifest.start_url).toBe("./");
    expect(manifest.scope).toBe("./");
    expect(manifest.icons).not.toHaveLength(0);

    for (const icon of manifest.icons) {
      expect(icon.src).not.toMatch(/^[/]/);
      expect(
        readFileSync(resolve(artifactRoot, "public", icon.src)),
      ).not.toHaveLength(0);
    }
  });

  it("lets Vite inject the configured base into install links", () => {
    const html = readFileSync(resolve(artifactRoot, "index.html"), "utf8");
    const worker = readFileSync(resolve(artifactRoot, "public/sw.js"), "utf8");

    expect(html).toContain('href="%BASE_URL%manifest.webmanifest"');
    expect(html).toContain('register("%BASE_URL%sw.js")');
    expect(worker).toContain("new URL(self.registration.scope).pathname");
  });
});