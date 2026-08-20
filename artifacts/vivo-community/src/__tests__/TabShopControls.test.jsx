import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({
  api: {
    products: vi.fn(),
    productsCount: vi.fn(),
    productFacets: vi.fn(),
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
  });

  it("keeps the compact catalogue controls and quiz quick-link without personalized requests", async () => {
    const user = userEvent.setup();
    render(<TabShop {...props} />);

    await waitFor(() => expect(api.products).toHaveBeenCalled());
    expect(screen.getByTestId("shop-filter-open")).toBeInTheDocument();
    expect(screen.getByTestId("shop-search")).toHaveClass("col-span-2");
    expect(screen.getByTestId("shop-sort")).toBeInTheDocument();
    expect(screen.queryByTestId("shop-styled-for-you")).not.toBeInTheDocument();
    expect(screen.queryByTestId("shop-my-size")).not.toBeInTheDocument();
    expect(screen.queryByTestId("shop-personalized-hint")).not.toBeInTheDocument();
    expect(api.styleQuiz).not.toHaveBeenCalled();
    expect(api.products.mock.calls[0][0]).not.toHaveProperty("personalize");

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
    expect(props.onOpenQuiz).toHaveBeenCalledOnce();
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