import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({
  api: {
    styledForYouStatus: vi.fn(),
    stylePrefsSave: vi.fn(),
  },
}));

import { api } from "@/lib/api";
import { StyledForYouHome } from "@/components/community/StyledForYou";

const MEMBER = { id: "member-1" };

describe("StyledForYouHome", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.styledForYouStatus.mockResolvedValue({ opted_in: false, sections: [] });
  });

  it("sends an opted-out member into the full preferences quiz", async () => {
    const user = userEvent.setup();
    const onPersonalise = vi.fn();

    render(<StyledForYouHome member={MEMBER} onViewAll={vi.fn()} onPersonalise={onPersonalise} />);

    const personalise = await screen.findByTestId("sfy-home-personalise");
    expect(screen.getByText("New")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Styled for You" })).toBeInTheDocument();
    expect(screen.getByText(
      "Get weekly outfit and product recommendations selected around your style, size and preferences."
    )).toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(screen.queryByText("Save preferences")).not.toBeInTheDocument();

    await user.click(personalise);

    expect(onPersonalise).toHaveBeenCalledOnce();
    expect(api.stylePrefsSave).not.toHaveBeenCalled();
  });

  it("restores an enrolled member's opt-in switch when opting out fails", async () => {
    const user = userEvent.setup();
    api.styledForYouStatus.mockResolvedValue({ opted_in: true, sections: [] });
    api.stylePrefsSave.mockRejectedValue(new Error("offline"));

    render(<StyledForYouHome member={MEMBER} onViewAll={vi.fn()} />);
    const toggle = await screen.findByRole("switch", {
      name: "Weekly Styled for You recommendations",
    });

    await user.click(toggle);

    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
    expect(screen.getByText("We couldn't update this right now. Please try again.")).toBeInTheDocument();
  });
});