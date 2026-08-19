import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import StyleBoardsLanding from "@/components/community/StyleBoardsLanding";

describe("StyleBoardsLanding", () => {
  it("renders the approved landing copy and starter boards", () => {
    render(<StyleBoardsLanding />);

    expect(screen.getByRole("heading", { level: 2, name: "Style Boards" })).toBeInTheDocument();
    expect(
      screen.getByText("Curated looks and outfit inspiration from the Vivo team — mix, match, and make them your own.")
    ).toBeInTheDocument();

    for (const title of [
      "Boardroom to Weekend",
      "Wedding Season Edit",
      "Prints We're Loving",
      "Monochrome Moments",
    ]) {
      expect(screen.getByRole("heading", { level: 3, name: title })).toBeInTheDocument();
    }

    expect(
      screen.getByText("Effortless pieces that carry you from Monday meetings to Saturday brunch.")
    ).toBeInTheDocument();
  });

  it("keeps follow interactive for members and fences it for guests", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<StyleBoardsLanding />);
    const memberFollowButtons = screen.getAllByTestId("follow-btn");

    await user.click(memberFollowButtons[0]);
    expect(memberFollowButtons[0]).toHaveTextContent("Following");

    const onGuest = vi.fn();
    rerender(<StyleBoardsLanding onGuest={onGuest} />);
    const guestFollowButtons = screen.getAllByTestId("follow-btn");
    await user.click(guestFollowButtons[1]);
    expect(onGuest).toHaveBeenCalledOnce();
    expect(guestFollowButtons[1]).toHaveTextContent("Follow");
  });
});