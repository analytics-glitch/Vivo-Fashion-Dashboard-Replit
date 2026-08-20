import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({
  api: {
    products: vi.fn(),
    productsCount: vi.fn(),
    productFacets: vi.fn(),
    shopCards: vi.fn(),
    styleQuiz: vi.fn(),
  },
}));

vi.mock("../components/community/VivoEdits", () => ({
  VivoEditsHome: () => <div data-testid="vivo-edits-mock" />,
}));

vi.mock("@/context/WishlistContext", () => ({
  useWishlist: () => ({ has: () => false, toggle: vi.fn() }),
}));

import { api } from "@/lib/api";
import TabShop from "@/components/community/TabShop";
import { CATEGORY_TILES, CategoryGrid } from "@/components/community/ShopSections";

const props = {
  onOpenProduct: vi.fn(),
  onOpenTryOn: vi.fn(),
  onOpenPage: vi.fn(),
  onOpenQuiz: vi.fn(),
  onOpenEdit: vi.fn(),
  onOpenEdits: vi.fn(),
};

describe("TabShop browsing controls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.products.mockResolvedValue({ items: [], categories: [], has_more: false });
    api.productsCount.mockResolvedValue({ total: 0 });
    api.productFacets.mockResolvedValue({
      categories: [], sizes: [], colors: [], price_bands: [], brands: [], prints: [],
    });
    api.shopCards.mockResolvedValue({
      cards: [
        { id: "delivery", image_url: "/api/community/shop-cards/delivery/image?v=1" },
        { id: "collection", image_url: "/api/community/shop-cards/collection/image?v=1" },
      ],
    });
  });

  it("keeps the compact catalogue controls and quiz quick-link without personalized requests", async () => {
    const user = userEvent.setup();
    render(<TabShop {...props} />);

    await waitFor(() => expect(api.products).toHaveBeenCalled());
    expect(screen.getByTestId("shop-filter-open")).toBeInTheDocument();
    expect(screen.getByTestId("shop-search")).toHaveClass("col-span-2");
    expect(screen.getByTestId("shop-sort")).toBeInTheDocument();
    expect(screen.getByTestId("shop-style-dna")).toHaveTextContent("Curate based on my Style DNA");
    expect(screen.getByTestId("shop-style-dna")).toHaveTextContent("Take the quiz to unlock");
    expect(screen.queryByTestId("shop-styled-for-you")).not.toBeInTheDocument();
    expect(screen.queryByTestId("shop-my-size")).not.toBeInTheDocument();
    expect(screen.queryByTestId("shop-personalized-hint")).not.toBeInTheDocument();
    expect(api.styleQuiz).not.toHaveBeenCalled();
    expect(api.products.mock.calls[0][0]).not.toHaveProperty("personalize");

    // The control is visible before the quiz is complete, but its tap sends
    // the member to Style Preferences rather than making a personalized call.
    await user.click(screen.getByTestId("shop-style-dna"));
    expect(props.onOpenQuiz).toHaveBeenCalledOnce();

    await user.click(screen.getByTestId("shop-filter-open"));
    expect(await screen.findByTestId("shop-filter-sheet")).toBeInTheDocument();
    await user.click(screen.getByTestId("filter-close"));
    expect(screen.queryByTestId("shop-filter-sheet")).not.toBeInTheDocument();

    await user.type(screen.getByTestId("shop-search-input"), "linen");
    await waitFor(() => expect(api.products.mock.calls.some(
      ([opts]) => opts.searchTerm === "linen" && !Object.hasOwn(opts, "personalize")
    )).toBe(true));

    await user.selectOptions(screen.getByTestId("shop-sort"), "price_asc");
    await waitFor(() => expect(api.products.mock.calls.some(
      ([opts]) => opts.sort === "price_asc" && !Object.hasOwn(opts, "personalize")
    )).toBe(true));

    await user.click(screen.getByTestId("shop-quick-quiz"));
    expect(props.onOpenQuiz).toHaveBeenCalledTimes(2);
  });

  it("renders configured Shop shortcut imagery while retaining every quick-link action", async () => {
    const user = userEvent.setup();
    render(<TabShop {...props} />);

    const delivery = await screen.findByTestId("shop-quick-delivery");
    await waitFor(() => expect(delivery.querySelector("img")).toHaveAttribute(
      "src", "/api/community/shop-cards/delivery/image?v=1"
    ));
    expect(screen.getByTestId("shop-quick-collection").querySelector("img")).toHaveAttribute(
      "src", "/api/community/shop-cards/collection/image?v=1"
    );
    expect(screen.getByTestId("shop-quick-quiz")).toHaveTextContent("Take Your Quiz");
    expect(screen.getByTestId("shop-quick-curators")).toHaveTextContent("Curated Looks By");

    await user.click(delivery);
    expect(props.onOpenPage).toHaveBeenCalledWith("delivery");
    await user.click(screen.getByTestId("shop-quick-quiz"));
    expect(props.onOpenQuiz).toHaveBeenCalledOnce();
  });

  it("uses Style DNA by default for a completed quiz and can turn it off and back on", async () => {
    const user = userEvent.setup();
    render(<TabShop {...props} member={{ quiz_completed: true }} />);

    const control = await screen.findByTestId("shop-style-dna");
    expect(control).toHaveAttribute("role", "switch");
    expect(control).toHaveAttribute("aria-checked", "true");
    expect(control).toHaveTextContent("From your style quiz results");
    await waitFor(() => expect(api.products.mock.calls.some(
      ([opts]) => opts.personalize === true
    )).toBe(true));

    await user.click(control);
    expect(control).toHaveAttribute("aria-checked", "false");
    await waitFor(() => expect(api.products.mock.calls.some(
      ([opts]) => !Object.hasOwn(opts, "personalize")
    )).toBe(true));

    await user.click(control);
    expect(control).toHaveAttribute("aria-checked", "true");
    await waitFor(() => expect(
      api.products.mock.calls.filter(([opts]) => opts.personalize === true)
    ).toHaveLength(2));
  });

  it("shows the Loungewear category tile with the existing image", () => {
    render(<CategoryGrid onSelect={vi.fn()} compact />);

    const loungewear = CATEGORY_TILES.find((tile) => tile.label === "Loungewear");
    expect(loungewear).toMatchObject({ img: "cat-active.jpg" });
    expect(screen.getByTestId("shop-cat-tile-loungewear")).toHaveTextContent("Loungewear");
  });

  it("uses the men's campaign image and keeps the For him entry point", () => {
    render(<CategoryGrid onSelect={vi.fn()} compact />);

    const mens = screen.getByTestId("shop-cat-tile-men-s");
    expect(mens).toHaveTextContent("For him");
    expect(mens).toHaveTextContent("Men's");
    expect(mens.querySelector("img")).toHaveAttribute("src", expect.stringContaining("/assets/brand/cat-mens.jpg"));
  });

  it("keeps colour swatches on the product image instead of repeating the colour name below it", async () => {
    const user = userEvent.setup();
    api.products.mockResolvedValue({
      items: [{
        sku: "SKU-1",
        style_name: "Satin Slip Dress",
        color: "Blue",
        image_url: "/dress.jpg",
        price: 4500,
        colourways: [
          { sku: "SKU-1", color: "Blue", image_url: "/dress-blue.jpg" },
          { sku: "SKU-2", color: "Red", image_url: "/dress-red.jpg" },
        ],
      }],
      categories: [],
      has_more: false,
    });

    render(<TabShop {...props} />);

    const card = await screen.findByTestId("product-card-SKU-1");
    const swatches = await screen.findByTestId("swatches-SKU-1");
    expect(swatches).toHaveClass("absolute", "bottom-2", "right-2");
    expect(swatches).toHaveAttribute("aria-label", "Colour options for Satin Slip Dress");
    expect(screen.getByTestId("swatch-SKU-1-SKU-1")).toBeInTheDocument();
    expect(screen.getByTestId("swatch-SKU-1-SKU-2")).toBeInTheDocument();
    expect(card).toHaveTextContent("Satin Slip Dress");
    expect(card).not.toHaveTextContent("Blue");
    expect(card).not.toHaveTextContent("Red");

    await user.click(screen.getByTestId("swatch-SKU-1-SKU-2"));
    expect(screen.getByAltText("Satin Slip Dress")).toHaveAttribute("src", "/dress-red.jpg");
    expect(props.onOpenProduct).not.toHaveBeenCalled();

    await user.click(card);
    expect(props.onOpenProduct).toHaveBeenCalledWith("SKU-2");
  });
});