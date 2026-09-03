import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({
  api: {},
}));

vi.mock("@/context/AuthContext", () => ({
  useAuth: () => ({
    signIn: vi.fn(),
    enterGuest: vi.fn(),
  }),
}));

import AuthFlow from "@/screens/AuthFlow";

describe("AuthFlow phone validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("explains why Continue is disabled for an incomplete Kenyan number", async () => {
    const user = userEvent.setup();
    render(<AuthFlow />);

    await user.click(screen.getByTestId("welcome-signin"));
    const phone = screen.getByTestId("input-phone");
    const continueButton = screen.getByTestId("btn-send-code");

    await user.type(phone, "72507914");

    expect(continueButton).toBeDisabled();
    expect(screen.getByText("Enter 9 digits after +254, for example 712 345 678.")).toBeInTheDocument();
    expect(phone).toHaveAttribute("aria-invalid", "true");
  });

  it("enables Continue once the complete subscriber number is entered", async () => {
    const user = userEvent.setup();
    render(<AuthFlow />);

    await user.click(screen.getByTestId("welcome-signin"));
    const phone = screen.getByTestId("input-phone");
    const continueButton = screen.getByTestId("btn-send-code");

    await user.type(phone, "725079140");

    expect(continueButton).not.toBeDisabled();
    expect(phone).toHaveAttribute("aria-invalid", "false");
  });
});