import React from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({
  api: {
    stylePrefs: vi.fn(),
    stylePrefsSave: vi.fn(),
    products: vi.fn(),
  },
}));

import { api } from "@/lib/api";
import { StylePrefsView } from "@/components/community/StyledForYou";

const PREFS = {
  opted_in: true,
  size: "M",
  fit: "Relaxed",
  colours: ["Green"],
  print_preferences: ["Plain"],
  colour_shades: ["Sage"],
  fabrics: ["Cotton"],
  categories: [],
  interests: ["Casual"],
  avoid: [],
  frequency: "weekly",
  notify_push: true,
  notify_email: false,
  use_activity: false,
};

const OPTIONS = {
  sizes: ["S", "M", "L"],
  fits: ["Fitted", "Relaxed"],
  colours: ["Green", "Neutrals"],
  print_preferences: ["Plain", "Prints"],
  colour_shades: ["Olive", "Sage", "Emerald"],
  fabrics: ["Cotton", "Silk", "Chiffon"],
  interests: ["Workwear", "Casual"],
  frequencies: ["weekly", "monthly"],
  journey: { tenures: [], discoveries: [], shop_frequencies: [] },
};

describe("Style Preferences visual choices", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.stylePrefs.mockResolvedValue({ prefs: PREFS, journey: null, options: OPTIONS });
    api.products.mockResolvedValue({ categories: [{ name: "Dresses" }] });
    api.stylePrefsSave.mockImplementation(async (payload) => ({
      prefs: payload,
      journey: null,
      options: OPTIONS,
    }));
  });

  it("renders the three image questions in the required order", async () => {
    render(<StylePrefsView onBack={vi.fn()} />);

    const favourite = await screen.findByText("Favourite colours");
    const plainPrint = screen.getByText("Plain or Prints");
    const shades = screen.getByText("Color Shades");
    const fabrics = screen.getByText("Fabrics");
    const categories = await screen.findByText("Preferred categories");

    const ordered = [favourite, plainPrint, shades, fabrics, categories];
    for (let i = 1; i < ordered.length; i += 1) {
      expect(ordered[i - 1].compareDocumentPosition(ordered[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }

    for (const testId of [
      "sfy-print-preferences-plain",
      "sfy-colour-shades-sage",
      "sfy-fabrics-cotton",
    ]) {
      const tile = screen.getByTestId(testId);
      expect(tile).toHaveAttribute("aria-pressed", "true");
      expect(tile.querySelector("img")?.getAttribute("src")).toMatch(/^data:image\/svg\+xml/);
    }
  });

  it("multi-selects visual answers and saves them with the existing preferences", async () => {
    const user = userEvent.setup();
    render(<StylePrefsView onBack={vi.fn()} />);

    const prints = await screen.findByTestId("sfy-print-preferences-prints");
    const emerald = screen.getByTestId("sfy-colour-shades-emerald");
    const silk = screen.getByTestId("sfy-fabrics-silk");

    await user.click(prints);
    await user.click(emerald);
    await user.click(silk);

    expect(screen.getByTestId("sfy-print-preferences-plain")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("sfy-print-preferences-prints")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("sfy-colour-shades-emerald")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("sfy-fabrics-silk")).toHaveAttribute("aria-pressed", "true");

    await user.click(screen.getByTestId("sfy-save"));

    expect(api.stylePrefsSave).toHaveBeenCalledWith(expect.objectContaining({
      print_preferences: ["Plain", "Prints"],
      colour_shades: ["Sage", "Emerald"],
      fabrics: ["Cotton", "Silk"],
    }));
    expect(await screen.findByTestId("sfy-saved")).toBeInTheDocument();
  });

  it("keeps each visual choice accessible by its text label", async () => {
    render(<StylePrefsView onBack={vi.fn()} />);
    const fabrics = await screen.findByText("Fabrics");
    const section = fabrics.closest("div.rounded") || fabrics.parentElement?.parentElement;
    expect(within(section).getByRole("button", { name: "Cotton" })).toBeInTheDocument();
    expect(within(section).getByRole("button", { name: "Silk" })).toBeInTheDocument();
  });
});