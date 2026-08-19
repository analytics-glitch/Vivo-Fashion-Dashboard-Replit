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

  it("opts a member in with one switch and no questionnaire", async () => {
    const user = userEvent.setup();
    api.stylePrefsSave.mockResolvedValue({ prefs: { opted_in: true } });

    render(<StyledForYouHome member={MEMBER} onViewAll={vi.fn()} />);

    const toggle = await screen.findByRole("switch", {
      name: "Weekly Styled for You recommendations",
    });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByText("Save preferences")).not.toBeInTheDocument();

    await user.click(toggle);

    expect(api.stylePrefsSave).toHaveBeenCalledWith({ opted_in: true });
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
    expect(screen.getByTestId("sfy-home-picks-cta")).toBeInTheDocument();
  });

  it("restores the previous switch state when saving fails", async () => {
    const user = userEvent.setup();
    api.stylePrefsSave.mockRejectedValue(new Error("offline"));

    render(<StyledForYouHome member={MEMBER} onViewAll={vi.fn()} />);
    const toggle = await screen.findByRole("switch", {
      name: "Weekly Styled for You recommendations",
    });

    await user.click(toggle);

    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "false"));
    expect(screen.getByText("We couldn't update this right now. Please try again.")).toBeInTheDocument();
  });
});