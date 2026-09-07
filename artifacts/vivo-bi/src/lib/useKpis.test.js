import { beforeEach, describe, expect, it, vi } from "vitest";

const { get } = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock("@/lib/api", () => ({
  api: { get },
  comparePeriod: vi.fn(),
}));

vi.mock("@/lib/filters", () => ({
  useFilters: vi.fn(),
}));

import {
  fetchKpis,
  invalidateKpis,
  KPI_REQUEST_TIMEOUT_MS,
} from "./useKpis";
import { getOverviewLoadState } from "./overviewLoadState";
import { loadOverviewFallback } from "./overviewFallback";

const params = {
  date_from: "2026-08-01",
  date_to: "2026-08-31",
  country: "Kenya",
  channel: "",
};

describe("fetchKpis recovery", () => {
  beforeEach(() => {
    invalidateKpis();
    get.mockReset();
  });

  it("coalesces concurrent cold loads and applies a request deadline", async () => {
    let resolve;
    get.mockReturnValue(new Promise((done) => { resolve = done; }));

    const first = fetchKpis(params);
    const waiter = fetchKpis(params);

    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0][1].timeout).toBe(KPI_REQUEST_TIMEOUT_MS);
    resolve({ data: { total_sales: 42 } });
    await expect(Promise.all([first, waiter])).resolves.toEqual([
      { total_sales: 42 },
      { total_sales: 42 },
    ]);
  });

  it("clears a failed shared request so retry can succeed", async () => {
    get
      .mockRejectedValueOnce(Object.assign(new Error("timed out"), { code: "ECONNABORTED" }))
      .mockResolvedValueOnce({ data: { total_sales: 84 } });

    await expect(fetchKpis(params)).rejects.toThrow("timed out");
    await expect(fetchKpis(params)).resolves.toEqual({ total_sales: 84 });
    expect(get).toHaveBeenCalledTimes(2);
  });
});

describe("Overview partial-data visibility", () => {
  it("renders loaded headline figures when dashboard sections fail", () => {
    expect(getOverviewLoadState({
      sectionLoading: false,
      kpiLoading: false,
      kpis: { total_sales: 42 },
      sectionError: "sections failed",
      kpiError: null,
    })).toEqual({
      showSkeleton: false,
      showError: true,
      showHeadline: true,
    });
  });

  it("ends the skeleton and offers recovery after a required request fails", () => {
    expect(getOverviewLoadState({
      sectionLoading: false,
      kpiLoading: false,
      kpis: null,
      sectionError: null,
      kpiError: "headline failed",
    })).toEqual({
      showSkeleton: false,
      showError: true,
      showHeadline: false,
    });
  });

  it("keeps successful optional sections when another section fails", async () => {
    const client = {
      get: vi.fn()
        .mockResolvedValueOnce({ data: [{ country: "Kenya" }] })
        .mockRejectedValueOnce(new Error("footfall unavailable"))
        .mockResolvedValueOnce({ data: [{ style_name: "A" }] }),
    };
    const result = await loadOverviewFallback(client, [
      { key: "countries", path: "/country-summary", params: {} },
      { key: "footfall", path: "/footfall", params: {} },
      { key: "styles", path: "/top-skus", params: {} },
    ], 25);

    expect(result.data).toEqual({
      countries: [{ country: "Kenya" }],
      styles: [{ style_name: "A" }],
    });
    expect(result.failed).toEqual(["footfall"]);
    expect(client.get.mock.calls.every(([, options]) => options.timeout === 25)).toBe(true);
  });
});