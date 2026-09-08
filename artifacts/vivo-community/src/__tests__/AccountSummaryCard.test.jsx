import React from "react";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AccountSummaryCard, WeeklyMissionsCard } from "@/components/community/RewardsSummaryCard";

const MEMBER = {
  name: "Sharon Wamae",
  full_name: "Sharon Wamae",
  initials: "SW",
  tier: "Tanzanite",
  username: "swamae",
  joined: "July 2022",
  points: 1586,
  lifetime_points: 1586,
  stats: { city: "Kenya", orders: 4, following: 12 },
};

describe("AccountSummaryCard", () => {
  it("combines identity, available balance, progress, and lifetime stats", () => {
    render(
      <>
        <AccountSummaryCard member={MEMBER} publishedPosts={3} />
        <WeeklyMissionsCard />
      </>
    );

    const card = screen.getByTestId("account-summary-card");
    expect(within(card).getByTestId("profile-name")).toHaveTextContent("Sharon Wamae");
    expect(within(card).getByTestId("profile-username")).toHaveTextContent("@swamae");
    expect(within(card).getByTestId("profile-username")).toHaveTextContent("your name stays private");
    expect(within(card).getByText("Kenya")).toBeInTheDocument();
    expect(within(card).getByText("Member since July 2022")).toBeInTheDocument();
    expect(within(card).getByText("You shine, Sharon.")).toBeInTheDocument();
    expect(within(card).getByTestId("rewards-points")).toHaveTextContent("1,586");
    expect(within(card).getByTestId("rewards-value")).toHaveTextContent("KES 2,500");
    expect(within(card).getByText("Tier Progress")).toBeInTheDocument();
    expect(within(card).getByTestId("profile-posts")).toHaveTextContent("3");
    expect(within(card).getByTestId("profile-points")).toHaveTextContent("1,586");
    expect(within(card).getByTestId("profile-orders")).toHaveTextContent("4");
    expect(within(card).getByText("12")).toBeInTheDocument();

    const missions = screen.getByTestId("weekly-missions");
    expect(missions).toBeInTheDocument();
    expect(card).not.toContainElement(missions);
  });
});