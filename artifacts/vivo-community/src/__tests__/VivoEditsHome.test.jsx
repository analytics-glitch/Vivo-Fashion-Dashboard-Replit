/**
 * VivoEditsHome — coverage moved from TabHome after the Home-vs-Shop rewire:
 * the section now lives on the Community tab (and, for guests, under the
 * Community GuestGate). Editorial reads stay guest-open.
 *
 * Covered:
 *   1. Renders edit cards when api.edits returns items; ≤3 shown, View All
 *      appears only when total > 3 and fires onViewAll.
 *   2. Clicking a card opens the edit via onOpenEdit.
 *   3. Renders nothing when there are no edits and no community looks.
 *   4. "Worn by the community" sub-cards carry NO Shop-the-Look CTA.
 */
import React from "react";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("@/lib/api", () => ({
  api: { edits: vi.fn() },
}));

import { api } from "@/lib/api";
import { VivoEditsHome } from "@/components/community/VivoEdits";

function makeEdit(overrides = {}) {
  const id = overrides.id ?? Math.random().toString(36).slice(2);
  return {
    id,
    creator_name: "Amina H",
    title: `Edit ${id}`,
    description: "A quiet, confident everyday look.",
    disclosure: "",
    featured: false,
    cover_image: `/api/community/edit-image/${id}`,
    cover_alt: `Look ${id}`,
    feed_post_id: null,
    ...overrides,
  };
}

describe("VivoEditsHome (Community placement)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.edits.mockResolvedValue({ items: [], total: 0 });
  });

  it("renders edit cards; no View All at ≤3 total", async () => {
    api.edits.mockResolvedValue({ items: [makeEdit({ id: "e1" }), makeEdit({ id: "e2" })], total: 2 });
    render(<VivoEditsHome onOpenEdit={vi.fn()} onViewAll={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("home-vivo-edits")).toBeInTheDocument());
    expect(screen.getByTestId("home-vivo-edit-e1")).toBeInTheDocument();
    expect(screen.getByTestId("home-vivo-edit-e2")).toBeInTheDocument();
    expect(screen.queryByTestId("home-vivo-edits-viewall")).not.toBeInTheDocument();
  });

  it("caps at 3 cards and shows View All when total > 3", async () => {
    const user = userEvent.setup();
    api.edits.mockResolvedValue({
      items: [makeEdit({ id: "a" }), makeEdit({ id: "b" }), makeEdit({ id: "c" }), makeEdit({ id: "d" })],
      total: 12,
    });
    const onViewAll = vi.fn();
    render(<VivoEditsHome onOpenEdit={vi.fn()} onViewAll={onViewAll} />);
    await waitFor(() => expect(screen.getByTestId("home-vivo-edits")).toBeInTheDocument());
    expect(screen.getByTestId("home-vivo-edit-c")).toBeInTheDocument();
    expect(screen.queryByTestId("home-vivo-edit-d")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("home-vivo-edits-viewall"));
    expect(onViewAll).toHaveBeenCalled();
  });

  it("clicking an edit card opens it via onOpenEdit", async () => {
    const user = userEvent.setup();
    api.edits.mockResolvedValue({ items: [makeEdit({ id: "open-me" })], total: 1 });
    const onOpenEdit = vi.fn();
    render(<VivoEditsHome onOpenEdit={onOpenEdit} onViewAll={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("home-vivo-edit-open-me")).toBeInTheDocument());
    await user.click(screen.getByTestId("home-vivo-edit-open-me"));
    expect(onOpenEdit).toHaveBeenCalledWith("open-me");
  });

  it("renders nothing when api.edits is empty or fails and no looks passed", async () => {
    const { unmount } = render(<VivoEditsHome onOpenEdit={vi.fn()} onViewAll={vi.fn()} />);
    await act(async () => {});
    expect(screen.queryByTestId("home-vivo-edits")).not.toBeInTheDocument();
    unmount();

    api.edits.mockRejectedValue(new Error("boom"));
    render(<VivoEditsHome onOpenEdit={vi.fn()} onViewAll={vi.fn()} />);
    await act(async () => {});
    expect(screen.queryByTestId("home-vivo-edits")).not.toBeInTheDocument();
  });

  it("worn-by-community looks render without any Shop-the-Look CTA", async () => {
    api.edits.mockResolvedValue({ items: [makeEdit({ id: "e1" })], total: 1 });
    const feed = [
      {
        id: "l1",
        post_type: "post",
        caption: "My look",
        tagged: [{ sku: "SKU-001", name: "Green Dress" }],
        author: { username: "user_l1", initials: "U", tier: "Tsavorite" },
      },
    ];
    render(<VivoEditsHome onOpenEdit={vi.fn()} onViewAll={vi.fn()} feed={feed} />);
    await waitFor(() => expect(screen.getByTestId("home-vivo-edits")).toBeInTheDocument());
    expect(screen.queryByTestId("shop-look-cta-l1")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /shop the look/i })).not.toBeInTheDocument();
  });
});
