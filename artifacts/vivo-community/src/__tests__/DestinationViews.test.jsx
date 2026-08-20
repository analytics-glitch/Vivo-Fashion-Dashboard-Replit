import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { ReferAFriendView, WeeklyMissionsView } from "@/components/community/DestinationViews";

const { api } = vi.hoisted(() => ({
  api: { referral: vi.fn(), sendReferralInvite: vi.fn() },
}));
vi.mock("@/lib/api", () => ({ api }));

describe("Rewards destination views", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.referral.mockResolvedValue({ code: "abcDef_123", reward_points: 200, reward_timing: "first_purchase" });
    api.sendReferralInvite.mockResolvedValue({ message: "Your invitation is on its way." });
  });

  it("builds a shareable referral link and sends the same invitation flow by email", async () => {
    const user = userEvent.setup();
    render(<ReferAFriendView onBack={vi.fn()} />);
    const link = await screen.findByLabelText("Your referral link");
    expect(link.value).toContain("?ref=abcDef_123");

    await user.type(screen.getByLabelText("Email Address"), "friend@example.com");
    await user.click(screen.getByRole("button", { name: /send invite/i }));

    await waitFor(() => expect(api.sendReferralInvite).toHaveBeenCalledWith(
      "friend@example.com",
      expect.stringContaining("?ref=abcDef_123"),
    ));
    expect(await screen.findByText("Your invitation is on its way.")).toBeInTheDocument();
  });

  it("lists the current weekly missions without inventing extra missions", () => {
    render(<WeeklyMissionsView onBack={vi.fn()} />);
    const landing = screen.getByTestId("weekly-missions-landing");
    expect(landing).toHaveTextContent("Leave a review");
    expect(landing).toHaveTextContent("Post a look");
    expect(landing).not.toHaveTextContent("Try a new store");
  });
});