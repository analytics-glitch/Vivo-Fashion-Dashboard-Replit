import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({
  api: {
    product: vi.fn(),
    products: vi.fn(),
    restockAlerts: vi.fn(),
    restockAlertSet: vi.fn(),
  },
}));

vi.mock("@/context/CartContext", () => ({
  useCart: () => ({ add: vi.fn() }),
}));

vi.mock("@/context/WishlistContext", () => ({
  useWishlist: () => ({ has: () => false, toggle: vi.fn() }),
}));

vi.mock("../components/community/mockData", () => ({
  fitFor: () => ({
    small: 10,
    true: 80,
    large: 10,
    verdict: "True to size",
    comments: [],
  }),
}));

import { api } from "@/lib/api";
import ProductDetail from "@/components/community/ProductDetail";

const detail = {
  sku: "STYLE-BLUE-M",
  name: "Nia Wrap Dress",
  style_number: "NIA-01",
  brand: "Vivo",
  color: "Blue",
  category: "Dresses",
  subcategory: "Dress",
  price: 5200,
  images: [],
  colorways: [],
  fabric: {},
  sizes: [
    { sku: "STYLE-BLUE-S", size: "S", in_stock: false, low: false },
    { sku: "STYLE-BLUE-M", size: "M", in_stock: true, low: false },
  ],
  in_stock: true,
};

const props = {
  sku: detail.sku,
  onBack: vi.fn(),
  onOpenProduct: vi.fn(),
  onTryOn: vi.fn(),
  onOpenPage: vi.fn(),
};

describe("Product detail restock alerts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.product.mockResolvedValue(detail);
    api.products.mockResolvedValue({ items: [] });
    api.restockAlerts.mockResolvedValue({ skus: [], alerts: [] });
    api.restockAlertSet.mockResolvedValue({ ok: true });
    window.scrollTo = vi.fn();
  });

  it("marks every sold-out size with a bell and lets a member select both channels", async () => {
    const user = userEvent.setup();
    render(<ProductDetail {...props} member={{ id: 7, email: "member@example.com" }} />);

    const soldOut = await screen.findByTestId("size-option-S");
    expect(soldOut.querySelector("svg")).toBeInTheDocument();

    await user.click(soldOut);
    expect(screen.getByRole("heading", {
      name: "Get notified when this is back in stock",
    })).toBeInTheDocument();
    expect(screen.getByTestId("notify-channel-push")).toBeChecked();
    expect(screen.getByTestId("notify-channel-email")).toBeChecked();
    expect(screen.queryByTestId("notify-email-input")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("notify-me-confirm"));
    await waitFor(() => expect(api.restockAlertSet).toHaveBeenCalledWith({
      product_sku: detail.sku,
      variant_sku: "STYLE-BLUE-S",
      all_variants: false,
      notify_push: true,
      notify_email: true,
      email: undefined,
    }));
    expect(await screen.findByTestId("notify-me-done")).toHaveTextContent(
      "You're on the list — we'll let you know when Nia Wrap Dress, S is back."
    );
  });

  it("replaces Add to Bag with NOTIFY ME when every variant is sold out and accepts a guest email", async () => {
    const user = userEvent.setup();
    api.product.mockResolvedValue({
      ...detail,
      sizes: detail.sizes.map((size) => ({ ...size, in_stock: false })),
      in_stock: false,
    });

    render(<ProductDetail {...props} member={null} />);

    const notify = await screen.findByTestId("pdp-notify-me");
    expect(notify).toHaveTextContent("NOTIFY ME");
    expect(screen.queryByTestId("add-to-cart-btn")).not.toBeInTheDocument();
    expect(screen.getByTestId("size-option-S").querySelector("svg")).toBeInTheDocument();
    expect(screen.getByTestId("size-option-M").querySelector("svg")).toBeInTheDocument();

    await user.click(notify);
    expect(screen.getByTestId("notify-channel-push")).toBeDisabled();
    expect(screen.getByTestId("notify-channel-email")).toBeChecked();
    await user.type(screen.getByTestId("notify-email-input"), "guest@example.com");
    await user.click(screen.getByTestId("notify-me-confirm"));

    await waitFor(() => expect(api.restockAlertSet).toHaveBeenCalledWith({
      product_sku: detail.sku,
      variant_sku: null,
      all_variants: true,
      notify_push: false,
      notify_email: true,
      email: "guest@example.com",
    }));
    expect(await screen.findByTestId("notify-me-done")).toHaveTextContent(
      "Nia Wrap Dress, all sizes"
    );
  });

  it("shows the duplicate state returned by the backend", async () => {
    const user = userEvent.setup();
    const duplicate = new Error("You're already on the list");
    duplicate.status = 409;
    api.restockAlertSet.mockRejectedValue(duplicate);

    render(<ProductDetail {...props} member={{ id: 7, email: "member@example.com" }} />);
    await user.click(await screen.findByTestId("size-option-S"));
    await user.click(screen.getByTestId("notify-me-confirm"));

    expect(await screen.findByTestId("notify-me-done")).toHaveTextContent(
      "You're already on the list"
    );
  });
});