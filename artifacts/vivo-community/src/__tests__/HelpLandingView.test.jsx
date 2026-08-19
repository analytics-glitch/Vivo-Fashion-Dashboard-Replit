import React from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import HelpLandingView from "@/components/community/HelpLandingView";

describe("HelpLandingView", () => {
  it("hosts the relocated Help & Support card in the original row order", async () => {
    const user = userEvent.setup();
    const onOpenPage = vi.fn();
    render(<HelpLandingView onBack={vi.fn()} onOpenPage={onOpenPage} />);

    const card = screen.getByTestId("help-legal-card");
    const ids = ["stores", "delivery", "returns", "faq", "tryon", "styleprefs", "contact", "terms", "privacy", "guidelines"];
    const rows = ids.map((id) => within(card).getByTestId(`help-link-${id}`));
    const cardNodes = Array.from(card.querySelectorAll("[data-testid]"));
    expect(rows.map((row) => cardNodes.indexOf(row))).toEqual([...rows.keys()]);

    await user.click(screen.getByTestId("help-link-tryon"));
    expect(onOpenPage).toHaveBeenCalledWith("tryon");
  });
});