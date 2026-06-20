import { vivoClient, consolidateHQBranches, isHQSource } from "./api";

const addDays = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};

let _cache = null;
let _cachePromise = null;
let _cacheTime = 0;

/**
 * Fetch the full, deduplicated branch list from /branch-rankings (last 30 days).
 * /branches only returns branches active today (1 branch when there's no check-in yet).
 * /branch-rankings gives us every branch with any activity recently. We then dedupe + consolidate HQ.
 * Cached for 5 minutes per session.
 */
export async function fetchAllBranches() {
  const now = Date.now();
  if (_cache && now - _cacheTime < 5 * 60 * 1000) return _cache;
  if (_cachePromise) return _cachePromise;
  const dateTo = addDays(0);
  const dateFrom = addDays(-30);
  _cachePromise = vivoClient
    .get("/branch-rankings", { params: { date_from: dateFrom, date_to: dateTo } })
    .then(({ data }) => {
      const list = (data || []).map((b) => ({
        branch_name: b.branch_name,
        branch_country: b.branch_country,
        location: b.location,
      }));
      // alphabetize stores; HQ first
      list.sort((a, b) => {
        const aHQ = isHQSource(a.branch_name) || a.branch_name === "HQ";
        const bHQ = isHQSource(b.branch_name) || b.branch_name === "HQ";
        if (aHQ && !bHQ) return -1;
        if (!aHQ && bHQ) return 1;
        return (a.branch_name || "").localeCompare(b.branch_name || "");
      });
      _cache = consolidateHQBranches(list);
      _cacheTime = Date.now();
      _cachePromise = null;
      return _cache;
    })
    .catch((err) => {
      _cachePromise = null;
      throw err;
    });
  return _cachePromise;
}
