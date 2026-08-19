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
    const firstCard = screen.getByTestId(`post-card-${posts[0].id}`);
    const clickTarget = within(firstCard).getByRole("button", {
      name: /open post/i,
    });
    await user.click(clickTarget);

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
      makePost({ id: "gamma" }),
    ];
    api.feed.mockResolvedValue({ items: posts });

    render(<TabHome member={MEMBER} {...NO_OP} />);
    await waitFor(() =>
      expect(screen.getByTestId("home-feed-preview")).toBeInTheDocument()
    );

    for (const post of posts) {
      // If the modal is open from a previous iteration, close it first.
      const closeBtn = screen.queryByTestId("post-close");
      if (closeBtn) await user.click(closeBtn);

      const card = screen.getByTestId(`post-card-${post.id}`);
      await user.click(within(card).getByRole("button", { name: /open post/i }));

      await waitFor(() =>
        expect(screen.getByTestId("post-detail")).toBeInTheDocument()
      );
      const modal = screen.getByTestId("post-detail");
      expect(within(modal).getByText(`@user_${post.id}`)).toBeInTheDocument();

      // Close modal before next iteration
      await user.click(screen.getByTestId("post-close"));
      await waitFor(() =>
        expect(screen.queryByTestId("post-detail")).not.toBeInTheDocument()
      );
    }
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
    const card = screen.getByTestId("post-card-first");
    await user.click(within(card).getByRole("button", { name: /open post/i }));
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
    await user.click(
      within(screen.getByTestId("post-card-one")).getByRole("button", { name: /open post/i })
    );
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

    await user.click(
      within(screen.getByTestId("post-card-k1")).getByRole("button", { name: /open post/i })
    );
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

  // ── 3. empty feed — no blank sections ─────────────────────────────────

  it("empty feed renders without home-feed-preview, style-question, or shop-looks sections", async () => {
    api.feed.mockResolvedValue({ items: [] });

    render(<TabHome member={MEMBER} {...NO_OP} />);

    // Wait for all effects to settle (api.feed resolved).
    await act(async () => {});

    expect(screen.queryByTestId("home-feed-preview")).not.toBeInTheDocument();
    expect(screen.queryByTestId("home-style-question")).not.toBeInTheDocument();
    expect(screen.queryByTestId("home-shop-looks")).not.toBeInTheDocument();
  });

  it("guest (no member prop) with empty feed shows community spotlight and not the feed preview", async () => {
    api.feed.mockResolvedValue({ items: [] });

    render(<TabHome member={null} {...NO_OP} />);
    await act(async () => {});

    expect(screen.queryByTestId("home-feed-preview")).not.toBeInTheDocument();
    expect(screen.getByTestId("home-community-spotlight")).toBeInTheDocument();
  });

  // ── 4. no questions in feed ────────────────────────────────────────────

  it("feed with no question posts hides the Style Question of the Week section", async () => {
    const posts = [
      makePost({ id: "v1", post_type: "post" }),
      makePost({ id: "v2", post_type: "post" }),
    ];
    api.feed.mockResolvedValue({ items: posts });

    render(<TabHome member={MEMBER} {...NO_OP} />);
    await waitFor(() =>
      expect(screen.getByTestId("home-feed-preview")).toBeInTheDocument()
    );

    expect(screen.queryByTestId("home-style-question")).not.toBeInTheDocument();
  });

  it("feed with a question post shows the Style Question of the Week section", async () => {
    const posts = [
      makePost({ id: "q1", post_type: "question", like_count: 5, comment_count: 3 }),
      makePost({ id: "v1", post_type: "post" }),
    ];
    api.feed.mockResolvedValue({ items: posts });

    render(<TabHome member={MEMBER} {...NO_OP} />);
    // The question is excluded from previewPosts so home-feed-preview may or
    // may not appear depending on how many non-question posts exist; we only
    // care that the question section appears.
    await waitFor(() =>
      expect(screen.getByTestId("home-style-question")).toBeInTheDocument()
    );
  });

  // ── 5. no tagged posts — shop-looks absent ─────────────────────────────

  it("feed with no tagged posts renders no community-look cards", async () => {
    const posts = [
      makePost({ id: "u1", tagged: [] }),
      makePost({ id: "u2", tagged: [] }),
    ];
    api.feed.mockResolvedValue({ items: posts });

    render(<TabHome member={MEMBER} {...NO_OP} />);
    await waitFor(() =>
      expect(screen.getByTestId("home-feed-preview")).toBeInTheDocument()
    );

    // The standalone section is gone; looks now live inside Vivo Edits —
    // untagged posts must not produce any shop-look card there either.
    expect(screen.queryByTestId("home-shop-looks")).not.toBeInTheDocument();
    expect(screen.queryByTestId("shop-look-u1")).not.toBeInTheDocument();
    expect(screen.queryByTestId("shop-look-u2")).not.toBeInTheDocument();
  });

  it("feed with tagged posts shows NO shop-look cards on Home (rewire: Vivo Edits moved to Community)", async () => {
    const posts = [
      makePost({ id: "t1", tagged: [{ sku: "SKU-001", name: "Green Dress" }] }),
      makePost({ id: "t2", tagged: [{ sku: "SKU-002", name: "Red Blouse" }] }),
    ];
    api.feed.mockResolvedValue({ items: posts });

    render(<TabHome member={MEMBER} {...NO_OP} />);
    await waitFor(() =>
      expect(screen.getByTestId("home-feed-preview")).toBeInTheDocument()
    );
    expect(screen.queryByTestId("home-vivo-edits")).not.toBeInTheDocument();
    expect(screen.queryByTestId("shop-look-t1")).not.toBeInTheDocument();
    expect(screen.queryByTestId("shop-look-t2")).not.toBeInTheDocument();
    // Home post cards carry no product tag pill buttons.
    expect(screen.queryByRole("button", { name: "Green Dress" })).not.toBeInTheDocument();
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

    await user.click(
      within(screen.getByTestId("post-card-z1")).getByRole("button", { name: /open post/i })
    );
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

  it("Home hero and endcap carry no shop CTAs (challenge is primary; shop is a quiet link)", async () => {
    render(<TabHome member={MEMBER} {...NO_OP} />);
    await act(async () => {});
    expect(screen.queryByTestId("hero-shop-now")).not.toBeInTheDocument();
    expect(screen.getByTestId("endcap-community")).toHaveTextContent(/challenge/i);
    expect(screen.getByTestId("endcap-shop")).toHaveTextContent(/Go to Shop/);
  });

  it("Home hero exposes separate look, community, and question actions", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    const onOpenCommunityComposer = vi.fn();
    render(
      <TabHome
        member={MEMBER}
        {...NO_OP}
        onNavigate={onNavigate}
        onOpenCommunityComposer={onOpenCommunityComposer}
      />,
    );
    await user.click(screen.getByTestId("hero-share-look"));
    await user.click(screen.getByTestId("hero-join-cta"));
    await user.click(screen.getByTestId("hero-start-conversation"));

    expect(onOpenCommunityComposer).toHaveBeenNthCalledWith(1, "look");
    expect(onNavigate).toHaveBeenCalledWith("community");
    expect(onOpenCommunityComposer).toHaveBeenNthCalledWith(2, "question");
  });

  it("does not render the duplicate rewards balance card on Home", async () => {
    render(<TabHome member={MEMBER} {...NO_OP} />);
    await act(async () => {});
    expect(screen.queryByTestId("home-rewards-card")).not.toBeInTheDocument();
    expect(screen.queryByTestId("home-rewards-cta")).not.toBeInTheDocument();
  });

  it("uses the compact What's On link to open Community Events", async () => {
    const user = userEvent.setup();
    const onOpenEvents = vi.fn();
    render(<TabHome member={MEMBER} {...NO_OP} onOpenEvents={onOpenEvents} />);

    await user.click(screen.getByTestId("home-events-link"));
    expect(onOpenEvents).toHaveBeenCalledOnce();
    expect(screen.queryByTestId("home-event-card")).not.toBeInTheDocument();
  });

  it("places Shop by Category on Home before the personalised section", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    render(<TabHome member={MEMBER} {...NO_OP} onNavigate={onNavigate} />);

    const promo = screen.getByTestId("shop-promo-banner");
    const genderToggle = screen.getByTestId("shop-gender-toggle");
    const categoryGrid = screen.getByTestId("shop-category-grid");
    const homeOrder = [promo, genderToggle, categoryGrid].map((node) =>
      Array.from(document.querySelectorAll("[data-testid]")).indexOf(node)
    );
    expect(homeOrder[0]).toBeLessThan(homeOrder[1]);
    expect(homeOrder[1]).toBeLessThan(homeOrder[2]);
    expect(categoryGrid).toBeInTheDocument();
    expect(screen.getAllByTestId(/shop-cat-tile-/)).toHaveLength(5);

    await user.click(screen.getByTestId("shop-cat-tile-workwear"));
    expect(onNavigate).toHaveBeenCalledWith("shop");
  });
});
