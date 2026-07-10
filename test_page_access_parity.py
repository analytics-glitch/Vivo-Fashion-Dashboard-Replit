"""Page-access parity gate: frontend ROLE_PAGES must mirror backend DEFAULT_ROLE_PAGES.

The sidebar / Home tiles are driven by the frontend role→pages map
(`artifacts/vivo-bi/src/lib/permissions.js` ROLE_PAGES) while login responses
inject the backend map (`api_pg.py` DEFAULT_ROLE_PAGES) as `allowed_pages`.
The convention says the two maps MUST stay in lockstep — an edit to one side
only would silently show a page whose API returns 403, or hide a page a group
should have. Nothing enforced that until this test.

What it pins down:

* the department-group keys are identical on both sides (and match
  VALID_ROLES / the ROLE_OPTIONS dropdown);
* every non-admin group's page set is EXACTLY equal between backend
  DEFAULT_ROLE_PAGES and frontend ROLE_PAGES (missing/extra ids are listed
  per group in the failure message);
* every page id referenced by either map exists in the backend page catalog
  (ALL_PAGE_IDS), so a typo'd or removed page id can't linger in a map.

The frontend map is obtained by ACTUALLY EVALUATING permissions.js with Node
(a dynamic ESM import that JSON-dumps the exports) — not by regex-parsing the
source — so spreads/filters like the SMT = leadership-minus-finance rule are
compared post-evaluation, exactly as the browser sees them.

Deliberately out of scope: the `admin-*` page ids inside the frontend ADMIN
list. `canAccessPage` returns True for role=admin before any list lookup and
the backend group-pages PUT strips `admin-` ids, so those entries are
cosmetic; comparing them against ADMIN_PAGE_IDS would fail on harmless drift
without protecting any real access path.

Run with the stdlib test path (no pytest in this env)::

    python -m unittest test_page_access_parity
"""
import json
import os
import subprocess
import unittest

import api_pg

ROOT = os.path.dirname(os.path.abspath(__file__))
PERMISSIONS_JS = os.path.join(
    ROOT, "artifacts", "vivo-bi", "src", "lib", "permissions.js"
)

_NODE_SNIPPET = (
    "const m = await import('file://' + process.argv[1]);"
    "console.log(JSON.stringify({ROLE_PAGES: m.ROLE_PAGES, ROLE_OPTIONS: m.ROLE_OPTIONS}));"
)


def _load_frontend():
    """Evaluate permissions.js with Node and return its exported maps."""
    proc = subprocess.run(
        ["node", "--input-type=module", "-e", _NODE_SNIPPET, PERMISSIONS_JS],
        capture_output=True,
        text=True,
        timeout=60,
    )
    if proc.returncode != 0:
        raise AssertionError(
            "Failed to evaluate permissions.js with Node "
            f"(exit {proc.returncode}):\n{proc.stderr.strip()}"
        )
    return json.loads(proc.stdout)


class PageAccessParityTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        frontend = _load_frontend()
        cls.fe_role_pages = frontend["ROLE_PAGES"]
        cls.fe_role_options = frontend["ROLE_OPTIONS"]
        cls.be_role_pages = api_pg.DEFAULT_ROLE_PAGES
        cls.valid_roles = set(api_pg.VALID_ROLES)
        cls.all_page_ids = set(api_pg.ALL_PAGE_IDS)

    # ── group keys stay in lockstep ──────────────────────────────────────────
    def test_group_keys_match(self):
        fe_keys = set(self.fe_role_pages)
        be_keys = set(self.be_role_pages)
        # Backend has no 'admin' entry by design (admin = full catalog).
        self.assertEqual(
            be_keys,
            self.valid_roles - {"admin"},
            "api_pg.DEFAULT_ROLE_PAGES keys drifted from VALID_ROLES "
            f"(missing={sorted((self.valid_roles - {'admin'}) - be_keys)}, "
            f"extra={sorted(be_keys - (self.valid_roles - {'admin'}))})",
        )
        self.assertEqual(
            fe_keys,
            self.valid_roles,
            "permissions.js ROLE_PAGES keys drifted from VALID_ROLES "
            f"(missing={sorted(self.valid_roles - fe_keys)}, "
            f"extra={sorted(fe_keys - self.valid_roles)})",
        )
        option_values = {o["value"] for o in self.fe_role_options}
        self.assertEqual(
            option_values,
            self.valid_roles,
            "permissions.js ROLE_OPTIONS drifted from VALID_ROLES "
            f"(missing={sorted(self.valid_roles - option_values)}, "
            f"extra={sorted(option_values - self.valid_roles)})",
        )

    # ── every non-admin group's page set is identical ────────────────────────
    def test_group_page_sets_match(self):
        problems = []
        for role in sorted(self.be_role_pages):
            be = set(self.be_role_pages[role])
            fe = set(self.fe_role_pages.get(role, []))
            missing_in_fe = sorted(be - fe)
            missing_in_be = sorted(fe - be)
            if missing_in_fe or missing_in_be:
                problems.append(
                    f"  {role}: only-in-backend={missing_in_fe} "
                    f"only-in-frontend={missing_in_be}"
                )
        self.assertFalse(
            problems,
            "Frontend ROLE_PAGES and backend DEFAULT_ROLE_PAGES drifted for "
            "these groups (edit BOTH permissions.js and api_pg.py in "
            "lockstep):\n" + "\n".join(problems),
        )

    # ── every referenced page id exists in the backend page catalog ─────────
    def test_page_ids_exist_in_catalog(self):
        problems = []
        for role, pages in sorted(self.be_role_pages.items()):
            unknown = sorted(set(pages) - self.all_page_ids)
            if unknown:
                problems.append(f"  backend {role}: {unknown}")
        for role, pages in sorted(self.fe_role_pages.items()):
            # admin-* ids are admin-route-guarded and never list-checked for
            # role=admin, so they're excluded from the catalog comparison.
            non_admin = {p for p in pages if not str(p).startswith("admin-")}
            unknown = sorted(non_admin - self.all_page_ids)
            if unknown:
                problems.append(f"  frontend {role}: {unknown}")
        self.assertFalse(
            problems,
            "Page ids referenced in the role→pages maps are missing from the "
            "backend page catalog (api_pg.ALL_PAGE_IDS):\n"
            + "\n".join(problems),
        )

    # ── the maps carry no duplicate ids (dupes hint at a bad merge) ──────────
    def test_no_duplicate_page_ids(self):
        problems = []
        for side, mapping in (
            ("backend", self.be_role_pages),
            ("frontend", self.fe_role_pages),
        ):
            for role, pages in sorted(mapping.items()):
                dupes = sorted({p for p in pages if pages.count(p) > 1})
                if dupes:
                    problems.append(f"  {side} {role}: {dupes}")
        self.assertFalse(
            problems,
            "Duplicate page ids inside a group's list:\n" + "\n".join(problems),
        )


if __name__ == "__main__":
    unittest.main()
