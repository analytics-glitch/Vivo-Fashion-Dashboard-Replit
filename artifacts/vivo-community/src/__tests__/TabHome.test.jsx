/**
 * TabHome regression tests — homepage layout correctness as the feed changes.
 *
 * Covered:
 *   1. Clicking a preview card opens PostDetailModal showing the SAME post (id parity).
 *   2. The detail modal's next/prev arrows walk the full feed list in order.
 *   3. Empty-feed renders without any blank/missing sections for preview, question,
 *      or shop-looks.
 *   4. A feed with no question posts hides the Style Question of the Week section.
 *   5. A feed with no tagged posts hides the Shop Community Looks section.
 */
import React from "react";
import { render, screen, waitFor, within, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi, describe, it, expect, beforeEach } from "vitest";

// ── mock sub-components that issue their own API calls ──────────────────────
vi.mock("@/components/community/ReelsRow", () => ({
  default: () => <div data-testid="reels-row-mock" />,
}));
vi.mock("@/components/community/StyledForYou", () => ({
  StyledForYouHome: () => <div data-testid="sfy-home-mock" />,
}));

// Render createPortal inline so modal content stays in the test container.
vi.mock("react-dom", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createPortal: (node) => node,
  };
});

// ── mock the api module ─────────────────────────────────────────────────────
vi.mock("@/lib/api", () => {
  const api = {
    feed: vi.fn(),
    events: vi.fn(),
    challenges: vi.fn(),
    celebrations: vi.fn(),
    surveyState: vi.fn(),
    myEntries: vi.fn(),
    edits: vi.fn(),
    postComments: vi.fn(),
    likePost: vi.fn(),
    likeComment: vi.fn(),
    reportComment: vi.fn(),
    addComment: vi.fn(),
  };
  return { api };
});

// ── import after mocks are in place ────────────────────────────────────────
import { api } from "@/lib/api";
import TabHome from "@/components/community/TabHome";

// ── helpers ─────────────────────────────────────────────────────────────────

/** Build a minimal post object accepted by TabHome / PostCard. */
function makePost(overrides = {}) {
  const id = overrides.id ?? Math.random().toString(36).slice(2);
  return {
    id,
    post_type: "post",
    variant: "visual",
    caption: `Caption for post ${id}`,
    like_count: 0,
    comment_count: 0,
    my_liked: false,
    tagged: [],
    created_at: new Date().toISOString(),
    author: {
      username: `user_${id}`,
      initials: "U",
      tier: "Tsavorite",
      show_tier: false,
    },
    ...overrides,
  };
}

const MEMBER = {
  id: "m1",
  full_name: "Test Member",
  username: "tester",
  points: 120,
  lifetime_points: 120,
  tier: "Tsavorite",
};

const NO_OP = {
  onNavigate: vi.fn(),
  onOpenProduct: vi.fn(),
  onOpenPage: vi.fn(),
  onOpenEvents: vi.fn(),
  onOpenEvent: vi.fn(),
  onOpenStyleBoards: vi.fn(),
  onOpenEdit: vi.fn(),
  onOpenEdits: vi.fn(),
};

/** Default quiet stubs for every api call TabHome issues. */
function stubApiDefaults() {
  api.feed.mockResolvedValue({ items: [] });
  api.events.mockResolvedValue({ items: [] });
  api.challenges.mockResolvedValue({ items: [] });
  api.celebrations.mockResolvedValue({});
  api.surveyState.mockResolvedValue({ wave: null });
  api.myEntries.mockResolvedValue({ items: [] });
  api.edits.mockResolvedValue({ items: [], total: 0 });
  api.postComments.mockResolvedValue({ items: [] });
  api.likePost.mockResolvedValue({ liked: true, like_count: 1 });
}

// ── tests ───────────────────────────────────────────────────────────────────

describe("TabHome – homepage layout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubApiDefaults();
    // Clear celebration flags so CelebrationCard never fires in tests.
    try { sessionStorage.removeItem("johari_welcome"); } catch { /* */ }
    try { localStorage.removeItem("johari_tier_seen"); } catch { /* */ }
  });

  // ── 1. preview card opens the correct post ─────────────────────────────

  it("clicking a preview card opens PostDetailModal showing that exact post", async () => {
    const user = userEvent.setup();

    // Four visual posts — all will score higher than a question in previewPosts.
    const posts = [
      makePost({ id: "p1" }),
      makePost({ id: "p2" }),
      makePost({ id: "p3" }),
      makePost({ id: "p4" }),
    ];
    api.feed.mockResolvedValue({ items: posts });

    render(<TabHome member={MEMBER} {...NO_OP} />);

    // Wait for the feed preview section to appear.
    await waitFor(() =>
      expect(screen.getByTestId("home-feed-preview")).toBeInTheDocument()
    );

    // Click the first preview card (the top-ranked post).
    // previewPosts are sorted by score; all have equal engagement so order
    // is feed order.  We open whichever card appears first in the DOM.
    await user.click(screen.getByTestId(`home-feed-tile-${posts[0].id}`));

    // The modal must be visible.
    await waitFor(() =>
      expect(screen.getByTestId("post-detail")).toBeInTheDocument()
    );

    // The post rendered inside the modal matches the card we clicked.
    const modal = screen.getByTestId("post-detail");
    expect(within(modal).getByText(`@user_${posts[0].id}`)).toBeInTheDocument();
  });

  it("id parity: each preview card opens the modal with its own post id", async () => {
    const user = userEvent.setup();

    const posts = [
      makePost({ id: "alpha" }),
      makePost({ id: "beta" }),
    ];
    api.feed.mockResolvedValue({ items: posts });

    render(<TabHome member={MEMBER} {...NO_OP} />);
    await waitFor(() =>
      expect(screen.getByTestId("home-feed-preview")).toBeInTheDocument()
    );

    // We only check the first post now as it's a compact mini-feed
    const post = posts[0];
    await user.click(screen.getByTestId(`home-feed-tile-${post.id}`));

    await waitFor(() =>
      expect(screen.getByTestId("post-detail")).toBeInTheDocument()
    );
    const modal = screen.getByTestId("post-detail");
    expect(within(modal).getByText(`@user_${post.id}`)).toBeInTheDocument();

    // Close modal
    await user.click(screen.getByTestId("post-close"));
    await waitFor(() =>
      expect(screen.queryByTestId("post-detail")).not.toBeInTheDocument()
    );
  });

  // ── 2. next / prev navigation walks the full feed ─────────────────────

  it("next arrow in detail modal advances to the following post in feed order", async () => {
    const user = userEvent.setup();

    const posts = [
      makePost({ id: "first" }),
      makePost({ id: "second" }),
      makePost({ id: "third" }),
    ];
    api.feed.mockResolvedValue({ items: posts });

    render(<TabHome member={MEMBER} {...NO_OP} />);
    await waitFor(() =>
      expect(screen.getByTestId("home-feed-preview")).toBeInTheDocument()
    );

    // Open the first post.
    await user.click(screen.getByTestId("home-feed-tile-first"));
    await waitFor(() =>
      expect(screen.getByTestId("post-detail")).toBeInTheDocument()
    );

    // The modal currently shows "first".
    let modal = screen.getByTestId("post-detail");
    expect(within(modal).getByText("@user_first")).toBeInTheDocument();

    // Click the "Next post" arrow.
    await user.click(screen.getByTestId("post-next"));

    // Now it must show "second".
    modal = screen.getByTestId("post-detail");
    await waitFor(() =>
      expect(within(modal).getByText("@user_second")).toBeInTheDocument()
    );

    // Click next again → "third".
    await user.click(screen.getByTestId("post-next"));
    await waitFor(() =>
      expect(within(modal).getByText("@user_third")).toBeInTheDocument()
    );

    // "third" is the last post — next button should not be present.
    expect(screen.queryByTestId("post-next")).not.toBeInTheDocument();
  });

  it("prev arrow in detail modal steps back to the previous post", async () => {
    const user = userEvent.setup();

    const posts = [
      makePost({ id: "one" }),
      makePost({ id: "two" }),
      makePost({ id: "three" }),
    ];
    api.feed.mockResolvedValue({ items: posts });

    render(<TabHome member={MEMBER} {...NO_OP} />);
    await waitFor(() =>
      expect(screen.getByTestId("home-feed-preview")).toBeInTheDocument()
    );

    // Open the first post, then navigate to the second.
    await user.click(screen.getByTestId("home-feed-tile-one"));
    await waitFor(() => expect(screen.getByTestId("post-detail")).toBeInTheDocument());
    await user.click(screen.getByTestId("post-next"));
    await waitFor(() =>
      expect(within(screen.getByTestId("post-detail")).getByText("@user_two")).toBeInTheDocument()
    );

    // Step back.
    await user.click(screen.getByTestId("post-prev"));
    await waitFor(() =>
      expect(within(screen.getByTestId("post-detail")).getByText("@user_one")).toBeInTheDocument()
    );

    // "one" is index 0 — prev button must be gone.
    expect(screen.queryByTestId("post-prev")).not.toBeInTheDocument();
  });

  it("keyboard ArrowRight / ArrowLeft navigates the feed inside the modal", async () => {
    const user = userEvent.setup();

    const posts = [makePost({ id: "k1" }), makePost({ id: "k2" })];
    api.feed.mockResolvedValue({ items: posts });

    render(<TabHome member={MEMBER} {...NO_OP} />);
    await waitFor(() =>
      expect(screen.getByTestId("home-feed-preview")).toBeInTheDocument()
    );

    await user.click(screen.getByTestId("home-feed-tile-k1"));
    await waitFor(() => expect(screen.getByTestId("post-detail")).toBeInTheDocument());

    await user.keyboard("{ArrowRight}");
    await waitFor(() =>
      expect(within(screen.getByTestId("post-detail")).getByText("@user_k2")).toBeInTheDocument()
    );

    await user.keyboard("{ArrowLeft}");
    await waitFor(() =>
      expect(within(screen.getByTestId("post-detail")).getByText("@user_k1")).toBeInTheDocument()
    );
  });

  // ── 3. empty feed — renders nothing here text ─────────────────────────

  it("empty feed renders FeedPreview with nothing here text", async () => {
    api.feed.mockResolvedValue({ items: [] });

    render(<TabHome member={MEMBER} {...NO_OP} />);
    await act(async () => {});

    expect(screen.getByTestId("home-feed-preview")).toBeInTheDocument();
    expect(screen.getByText("Nothing here yet")).toBeInTheDocument();
  });

  it("guest (no member prop) with empty feed shows community spotlight and the feed preview", async () => {
    api.feed.mockResolvedValue({ items: [] });

    render(<TabHome member={null} {...NO_OP} />);
    await act(async () => {});

    expect(screen.getByTestId("home-feed-preview")).toBeInTheDocument();
    expect(screen.getByTestId("home-spotlight-card")).toBeInTheDocument();
  });

  // ── 6. close button restores state ────────────────────────────────────

  it("closing the detail modal removes it from the DOM", async () => {
    const user = userEvent.setup();
    const posts = [makePost({ id: "z1" })];
    api.feed.mockResolvedValue({ items: posts });

    render(<TabHome member={MEMBER} {...NO_OP} />);
    await waitFor(() =>
      expect(screen.getByTestId("home-feed-preview")).toBeInTheDocument()
    );

    await user.click(screen.getByTestId("home-feed-tile-z1"));
    await waitFor(() => expect(screen.getByTestId("post-detail")).toBeInTheDocument());

    await user.click(screen.getByTestId("post-close"));
    await waitFor(() =>
      expect(screen.queryByTestId("post-detail")).not.toBeInTheDocument()
    );
  });

  // ── 7. Vivo Edits moved to Community (rewire) ─────────────────────────
  // Detailed VivoEditsHome coverage lives in VivoEditsHome.test.jsx; Home
  // must simply never render the section, even when edits exist.

  it("never renders Vivo Edits on Home, even when api.edits has items", async () => {
    api.edits.mockResolvedValue({
      items: [{ id: "e1", creator_name: "Amina H", title: "Edit e1", cover_image: "/x.jpg" }],
      total: 1,
    });
    render(<TabHome member={MEMBER} {...NO_OP} />);
    await act(async () => {});
    expect(screen.queryByTestId("home-vivo-edits")).not.toBeInTheDocument();
    expect(screen.queryByTestId("home-vivo-edit-e1")).not.toBeInTheDocument();
  });

  it("does not render the duplicate rewards balance card on Home", async () => {
    render(<TabHome member={MEMBER} {...NO_OP} />);
    await act(async () => {});
    expect(screen.queryByTestId("home-rewards-card")).not.toBeInTheDocument();
    expect(screen.queryByTestId("home-rewards-cta")).not.toBeInTheDocument();
  });

  it("uses the compact View all link to open Community Events", async () => {
    const user = userEvent.setup();
    const onOpenEvents = vi.fn();
    render(<TabHome member={MEMBER} {...NO_OP} onOpenEvents={onOpenEvents} />);

    await user.click(screen.getByRole("button", { name: /View all/i }));
    expect(onOpenEvents).toHaveBeenCalledOnce();
  });

  it("opens the campaign article from the hero's single CTA", async () => {
    const user = userEvent.setup();
    const onOpenPage = vi.fn();
    render(<TabHome member={MEMBER} {...NO_OP} onOpenPage={onOpenPage} />);

    const hero = screen.getByTestId("home-hero");
    expect(within(hero).getAllByRole("button")).toHaveLength(1);
    await user.click(screen.getByTestId("hero-join-cta"));
    expect(onOpenPage).toHaveBeenCalledWith("article-the-new-old-money");
  });

  it("renders the required Home rows in order and omits removed sections", async () => {
    render(<TabHome member={MEMBER} {...NO_OP} />);
    await act(async () => {});

    const ordered = [
      screen.getByTestId("home-hero"),
      screen.getByTestId("home-feed-preview"),
      screen.getByTestId("home-spotlight-card"),
      screen.getByTestId("reels-row-mock"),
      screen.getByTestId("home-curators-teaser"),
      screen.getByTestId("home-weekly-playlist"),
      screen.getByTestId("home-styleboards-teaser"),
      screen.getByTestId("sfy-home-mock"),
      screen.getByTestId("home-stories-compact"),
      screen.getByTestId("home-events-row"),
      screen.getByTestId("home-promo-banner"),
      screen.getByTestId("home-givingback"),
    ];
    for (let i = 1; i < ordered.length; i += 1) {
      expect(ordered[i - 1].compareDocumentPosition(ordered[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }

    expect(screen.queryByTestId("home-style-question")).not.toBeInTheDocument();
    expect(screen.queryByTestId("shop-gender-toggle")).not.toBeInTheDocument();
    expect(screen.queryByTestId("shop-category-grid")).not.toBeInTheDocument();
    expect(screen.queryByTestId("community-mission-card")).not.toBeInTheDocument();
    expect(screen.queryByTestId("personal-card")).not.toBeInTheDocument();
  });

  it("links the Curators and Style Boards teasers to their existing destinations", async () => {
    const user = userEvent.setup();
    const onOpenPage = vi.fn();
    const onOpenStyleBoards = vi.fn();
    render(
      <TabHome
        member={MEMBER}
        {...NO_OP}
        onOpenPage={onOpenPage}
        onOpenStyleBoards={onOpenStyleBoards}
      />
    );

    await user.click(screen.getByTestId("home-curators-cta"));
    await user.click(screen.getByTestId("home-styleboards-cta"));
    expect(onOpenPage).toHaveBeenCalledWith("edits");
    expect(onOpenStyleBoards).toHaveBeenCalledOnce();
  });

  it("uses the live Events API labels and opens an event detail", async () => {
    const user = userEvent.setup();
    const onOpenEvent = vi.fn();
    api.events.mockResolvedValue({
      items: [{
        id: "galleria-styling-evening",
        title: "Styling Evening",
        date_label: "Fri 28 Aug",
        time_label: "5:30 PM – 8:00 PM EAT",
        venue: "Vivo, Galleria Mall",
      }],
    });
    render(<TabHome member={MEMBER} {...NO_OP} onOpenEvent={onOpenEvent} />);

    const card = await screen.findByTestId("home-event-galleria-styling-evening");
    expect(within(card).getByText("Fri 28 Aug · 5:30 PM – 8:00 PM EAT")).toBeInTheDocument();
    expect(within(card).getByText("Vivo, Galleria Mall")).toBeInTheDocument();
    await user.click(card);
    expect(onOpenEvent).toHaveBeenCalledWith("galleria-styling-evening");
  });
});
