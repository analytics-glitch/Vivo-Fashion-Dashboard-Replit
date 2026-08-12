"""Route/access regression gate for the Merchandising Hub's "Buying Order Status" tab.

The Merchandising Hub embeds the Production Overview page (buying-order KPIs,
stage flow, delivery outlook) as tab id ``pd-buying-orders``, gated by the
``production`` page id. This test pins the invariant that broke once in
review: a hub tab is only reachable if the hub ROUTE's ``anyOfPageIds``
allowlist admits every user who can see the tab.

Concretely: the ``/merchandising`` route must OR ``production`` into its
allowlist (mirroring ``/product-analysis``, which ORs the page id of its own
embedded copy of the same page). Without it, a user who holds ``production``
but no ``merch-*`` page id — e.g. via a stored Group Access override, which
freezes a literal page-id list — passes the tab-level gate but is bounced by
route authorization, so the ``?tab=pd-buying-orders`` deep link dead-ends on
the home shell.

The frontend has no JS test harness, so like ``test_page_access_parity`` this
suite inspects the frontend sources from Python. Unlike permissions.js, the
two files under test are JSX and cannot be evaluated with plain Node, so the
relevant literals are extracted with targeted parsing instead.

Run with the stdlib test path (no pytest in this env)::

    python -m unittest test_merch_buying_order_tab_access
"""
import os
import re
import unittest

ROOT = os.path.dirname(os.path.abspath(__file__))
APP_JS = os.path.join(ROOT, "artifacts", "vivo-bi", "src", "App.js")
HUB_JSX = os.path.join(
    ROOT, "artifacts", "vivo-bi", "src", "pages", "MerchandisingHub.jsx"
)

TAB_ID = "pd-buying-orders"
TAB_LABEL = "Buying Order Status"
TAB_PAGE_ID = "production"


def _read(path):
    with open(path, encoding="utf-8") as fh:
        return fh.read()


def _merch_route_allowlist(app_src):
    """Return the anyOfPageIds list of the /merchandising Route element."""
    m = re.search(
        r'path="/merchandising".*?anyOfPageIds=\{\[(.*?)\]\}', app_src, re.S
    )
    if not m:
        raise AssertionError(
            "Could not locate the /merchandising <Route> with an anyOfPageIds "
            "allowlist in App.js — if the route was restructured, update this "
            "test so the deep-link invariant stays pinned."
        )
    return re.findall(r'"([^"]+)"', m.group(1))


def _buying_order_tab_entry(hub_src):
    """Return the pd-buying-orders MERCH_TABS entry as a dict of string props."""
    m = re.search(r'\{[^{}]*\bid:\s*"%s"[^{}]*\}' % re.escape(TAB_ID), hub_src)
    if not m:
        return None
    return dict(re.findall(r'(\w+):\s*"([^"]*)"', m.group(0)))


class MerchBuyingOrderTabAccessTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.allowlist = _merch_route_allowlist(_read(APP_JS))
        cls.tab = _buying_order_tab_entry(_read(HUB_JSX))

    def test_route_parse_sanity(self):
        """The extracted allowlist really is the merch hub's (guards the parser)."""
        self.assertIn(
            "merch-overview",
            self.allowlist,
            "Parsed a page-id list that does not look like the /merchandising "
            "route allowlist — the extraction regex grabbed the wrong element.",
        )

    def test_hub_registers_buying_order_tab(self):
        self.assertIsNotNone(
            self.tab,
            f'MERCH_TABS no longer contains an entry with id "{TAB_ID}" — the '
            "Buying Order Status tab was removed or renamed.",
        )
        self.assertEqual(self.tab.get("label"), TAB_LABEL)
        self.assertEqual(
            self.tab.get("pageId"),
            TAB_PAGE_ID,
            f'The "{TAB_LABEL}" tab must stay gated by the "{TAB_PAGE_ID}" page '
            "id — the same gate as the original page it embeds.",
        )

    def test_route_allowlist_admits_the_tab_gate(self):
        """Everyone who can see the tab must be able to open its deep link."""
        page_id = (self.tab or {}).get("pageId", TAB_PAGE_ID)
        self.assertIn(
            page_id,
            self.allowlist,
            f'The /merchandising route allowlist must OR the "{page_id}" page '
            f'id: the "{TAB_LABEL}" tab is visible to any user holding '
            f'"{page_id}", so users granted it WITHOUT any merch-* page id '
            "(e.g. via a stored Group Access override) would otherwise pass "
            "the tab gate but get bounced by route authorization, dead-ending "
            f"the ?tab={TAB_ID} deep link.",
        )


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
