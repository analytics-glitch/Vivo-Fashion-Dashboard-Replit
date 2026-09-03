import React from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import GivingBackView from "@/components/community/GivingBackView";

describe("GivingBackView", () => {
  it("renders the how-it-works steps and blank partner details", () => {
    render(<GivingBackView onBack={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "How it works" })).toBeInTheDocument();
    expect(screen.getByTestId("givingback-step-1")).toHaveTextContent(
      "Pack up the Vivo pieces you've outgrown."
    );
    expect(screen.getByTestId("givingback-step-2")).toHaveTextContent(
      "Drop them off at any Vivo store, or directly at [X Home] — address and hours below."
    );
    expect(screen.getByTestId("givingback-step-3")).toHaveTextContent(
      "Your pre-loved pieces help another woman feel confident as she takes her next step."
    );
    expect(screen.getByRole("heading", { name: "[X Home]" })).toBeInTheDocument();

    for (const key of ["address", "hours", "contact"]) {
      const detail = screen.getByTestId(`xhome-${key}`);
      expect(within(detail).getByText(key === "hours" ? "Drop-off hours" : key === "contact" ? "Contact info" : "Address")).toBeInTheDocument();
      expect(detail.querySelector("dd")).not.toBeNull();
      expect(detail.querySelector("dd").textContent).toBe("");
    }
  });

  it("returns to the Home page through the back button", async () => {
    const user = userEvent.setup();
    const onBack = vi.fn();
    render(<GivingBackView onBack={onBack} />);

    await user.click(screen.getByTestId("givingback-back"));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});