import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";
import TabRewards from "@/components/community/TabRewards";

const { api } = vi.hoisted(() => ({
  api: {
    rewardsTank: vi.fn(),
    tryonAllowance: vi.fn(),
    stylePrefs: vi.fn(),
    myEntries: vi.fn(),
    myRedemptions: vi.fn(),
  },
}));

vi.mock("@/lib/api", () => ({ api }));

describe("TabRewards Ways to Earn", () => {
  const props = {
    member: { id: 7, name: "Sharon", joined: "August 2026", recent_orders: [] },
    onMemberUpdate: vi.fn(),
    onOpenPage: vi.fn(),
    onOpenShop: vi.fn(),
    onOpenCommunity: vi.fn(),
    onOpenChallenges: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    api.rewardsTank.mockResolvedValue({});
    api.tryonAllowance.mockResolvedValue({});
    api.stylePrefs.mockResolvedValue({});
    api.myEntries.mockResolvedValue({ items: [] });
    api.myRedemptions.mockResolvedValue({ redemptions: [] });
  });

  it("keeps the intended destinations, while removing photo and video review tiles", async () => {
    const user = userEvent.setup();
    render(<TabRewards {...props} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /purchases/i })).toBeInTheDocument());

    expect(screen.queryByText("Photo Review")).not.toBeInTheDocument();
    expect(screen.queryByText("Video Review")).not.toBeInTheDocument();
    expect(screen.getByText("Fit Notes")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /fit notes/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /purchases/i }));
    await user.click(screen.getByRole("button", { name: /text review/i }));
    await user.click(screen.getByRole("button", { name: /community look — photo/i }));
    await user.click(screen.getByRole("button", { name: /join challenge/i }));
    await user.click(screen.getByRole("button", { name: /refer a friend/i }));
    await user.click(screen.getByRole("button", { name: /weekly missions/i }));

    expect(props.onOpenShop).toHaveBeenCalledOnce();
    expect(props.onOpenCommunity).toHaveBeenCalledTimes(2);
    expect(props.onOpenChallenges).toHaveBeenCalledOnce();
    expect(props.onOpenPage).toHaveBeenCalledWith("refer");
    expect(props.onOpenPage).toHaveBeenCalledWith("missions");
  });
});