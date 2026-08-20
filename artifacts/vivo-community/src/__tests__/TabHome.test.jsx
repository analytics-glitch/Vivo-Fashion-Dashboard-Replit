import React from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/community/ReelsRow", () => ({
  default: () => <div data-testid="reels-row-mock">Fresh from Vivo</div>,
}));
vi.mock("@/components/community/StyledForYou", () => ({
  StyledForYouHome: () => <div data-testid="sfy-home-mock">Styled for You</div>,
}));

vi.mock("@/lib/api", () => ({
  api: {
    celebrations: vi.fn(),
    events: vi.fn(),
  },
}));

import { api } from "@/lib/api";
import TabHome from "@/components/community/TabHome";

const MEMBER = {
  id: "m1",
  full_name: "Test Member",
  tier: "Tsavorite",
};

const NO_OP = {
  onNavigate: vi.fn(),
  onOpenProduct: vi.fn(),
  onOpenPage: vi.fn(),
  onOpenEvents: vi.fn(),
  onOpenEvent: vi.fn(),
  onOpenStyleBoards: vi.fn(),
};

describe("TabHome image teasers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.celebrations.mockResolvedValue({});
    api.events.mockResolvedValue({ items: [] });
  });

  it("renders the approved copy on all five responsive image banners", async () => {
    render(<TabHome member={MEMBER} {...NO_OP} />);
    await act(async () => {});

    expect(screen.getByText("Vivo Spotted on Our Community")).toBeInTheDocument();
    expect(screen.getByText("Styled by Our Influencers")).toBeInTheDocument();
    expect(screen.getByText("Real looks from the creators who bring Vivo to life.")).toBeInTheDocument();
    expect(screen.getByText("In partnership with Vivo")).toBeInTheDocument();
    expect(screen.getByText("Style Boards, Curated by Us")).toBeInTheDocument();
    expect(screen.getByText("Mood boards and outfit inspiration, put together by the Vivo team.")).toBeInTheDocument();
    expect(screen.getByText("See the boards")).toBeInTheDocument();
    expect(screen.getByText("Join a Challenge")).toBeInTheDocument();
    expect(screen.getByText("Style prompts, community missions, and rewards for taking part.")).toBeInTheDocument();
    expect(screen.getByText("See the challenges")).toBeInTheDocument();
    expect(screen.getByText("This Month in Johari")).toBeInTheDocument();
    expect(screen.getByText("Milestones, new stores and what's next for Vivo.")).toBeInTheDocument();

    const testIds = [
      "home-community-teaser",
      "home-curators-teaser",
      "home-styleboards-teaser",
      "home-challenges-teaser",
      "home-stories-compact",
    ];
    for (const testId of testIds) {
      const banner = screen.getByTestId(testId);
      const image = within(banner).getByRole("img");
      expect(image).toHaveAttribute("srcset", expect.stringContaining("640w"));
      expect(image).toHaveAttribute("srcset", expect.stringContaining("960w"));
      expect(image).toHaveAttribute("sizes", expect.stringContaining("max-width: 767px"));
      expect(image).toHaveAttribute("loading", "lazy");
    }
  });

  it("links each teaser to its established destination", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    const onOpenPage = vi.fn();
    const onOpenStyleBoards = vi.fn();
    const onOpenChallenges = vi.fn();
    render(
      <TabHome
        member={MEMBER}
        {...NO_OP}
        onNavigate={onNavigate}
        onOpenPage={onOpenPage}
        onOpenStyleBoards={onOpenStyleBoards}
        onOpenChallenges={onOpenChallenges}
      />
    );

    await user.click(screen.getByTestId("home-view-community"));
    await user.click(screen.getByTestId("home-curators-cta"));
    await user.click(screen.getByTestId("home-styleboards-cta"));
    await user.click(screen.getByTestId("home-challenges-cta"));
    await user.click(screen.getByTestId("home-johari-news-cta"));

    expect(onNavigate).toHaveBeenCalledWith("community");
    expect(onOpenPage).toHaveBeenCalledWith("edits");
    expect(onOpenStyleBoards).toHaveBeenCalledOnce();
    expect(onOpenChallenges).toHaveBeenCalledOnce();
    expect(onOpenPage).toHaveBeenCalledWith(expect.stringMatching(/^news-/));
  });

  it("opens the active community spotlight as a real article", async () => {
    const user = userEvent.setup();
    const onOpenPage = vi.fn();
    api.celebrations.mockResolvedValue({
      jewel: {
        username: "nyambura.k",
        tier: "Tanzanite",
        show_tier: true,
        quote: "Finding a community that celebrates African curves has completely changed how I shop.",
        article_slug: "nyambura-finding-her-shape",
      },
    });

    render(<TabHome member={MEMBER} {...NO_OP} onOpenPage={onOpenPage} />);
    await waitFor(() => expect(screen.getByText("@nyambura.k")).toBeInTheDocument());
    await user.click(screen.getByTestId("spotlight-story-cta"));

    expect(onOpenPage).toHaveBeenCalledWith("article-nyambura-finding-her-shape");
  });

  it("keeps the approved section order around the new banners", async () => {
    render(<TabHome member={MEMBER} {...NO_OP} />);
    await act(async () => {});

    const ordered = [
      screen.getByTestId("home-hero"),
      screen.getByTestId("home-community-teaser"),
      screen.getByTestId("home-spotlight-card"),
      screen.getByTestId("reels-row-mock"),
      screen.getByTestId("home-curators-teaser"),
      screen.getByTestId("home-weekly-playlist"),
      screen.getByTestId("home-styleboards-teaser"),
      screen.getByTestId("sfy-home-mock"),
      screen.getByTestId("home-stories-compact"),
      screen.getByTestId("home-events-row"),
      screen.getByTestId("home-challenges-teaser"),
      screen.getByTestId("home-promo-banner"),
      screen.getByTestId("home-givingback"),
    ];

    for (let i = 1; i < ordered.length; i += 1) {
      expect(ordered[i - 1].compareDocumentPosition(ordered[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it("keeps the Hero CTA as the only hero action", async () => {
    const user = userEvent.setup();
    const onOpenPage = vi.fn();
    render(<TabHome member={MEMBER} {...NO_OP} onOpenPage={onOpenPage} />);

    const hero = screen.getByTestId("home-hero");
    expect(within(hero).getAllByRole("button")).toHaveLength(1);
    await user.click(screen.getByTestId("hero-join-cta"));
    expect(onOpenPage).toHaveBeenCalledWith("article-the-new-old-money");
  });

  it("continues to render live event labels and opens event detail", async () => {
    const user = userEvent.setup();
    const onOpenEvent = vi.fn();
    api.events.mockResolvedValue({
      items: [{
        id: "galleria-styling-evening",
        title: "Styling Evening",
        image: "galleria-styling-evening.jpg",
        date_label: "Fri 28 Aug",
        time_label: "5:30 PM – 8:00 PM EAT",
        venue: "Vivo, Galleria Mall",
      }],
    });

    render(<TabHome member={MEMBER} {...NO_OP} onOpenEvent={onOpenEvent} />);
    const card = await screen.findByTestId("home-event-galleria-styling-evening");
    expect(within(card).getByText("Fri 28 Aug · 5:30 PM – 8:00 PM EAT")).toBeInTheDocument();
    await user.click(card);
    expect(onOpenEvent).toHaveBeenCalledWith("galleria-styling-evening");
  });

  it("still omits removed Home modules", async () => {
    render(<TabHome member={MEMBER} {...NO_OP} />);
    await waitFor(() => expect(api.events).toHaveBeenCalled());

    expect(screen.queryByTestId("home-style-question")).not.toBeInTheDocument();
    expect(screen.queryByTestId("shop-gender-toggle")).not.toBeInTheDocument();
    expect(screen.queryByTestId("shop-category-grid")).not.toBeInTheDocument();
    expect(screen.queryByTestId("home-rewards-card")).not.toBeInTheDocument();
  });

  it("shows the approved Styled for You copy to guests", async () => {
    const user = userEvent.setup();
    const onOpenPage = vi.fn();
    render(<TabHome member={null} {...NO_OP} onOpenPage={onOpenPage} />);
    await act(async () => {});

    expect(screen.getByText("New")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Styled for You" })).toBeInTheDocument();
    expect(screen.getByText(
      "Get weekly outfit and product recommendations selected around your style, size and preferences."
    )).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Personalise My Style" }));
    expect(onOpenPage).toHaveBeenCalledWith("styleprefs");
  });
});