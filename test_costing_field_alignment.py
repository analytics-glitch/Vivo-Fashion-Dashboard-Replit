"""Static-analysis guard for costing-sheet field alignment.

The costing-sheet flex rows use ``align-items:flex-end`` to keep all field
label tops horizontally aligned.  That only works while every field wrapper
div stays the **same intrinsic height** (label + input).  Helper-text divs
that sit inside a wrapper as normal block children push that wrapper taller,
which shifts its label upward and breaks alignment.

The fix — position:absolute on the helper + position:relative on the wrapper —
must be applied consistently.  This test enforces the invariant statically so
that adding a new helper note without the wrapper treatment fails CI before it
ships.

Invariant checked for every field wrapper <div> that is a *direct child* of
either flex row:

  1. If the wrapper contains any block-level <div> that appears AFTER the
     field's <input> or <select> AND is not a dropdown menu
     (class contains "resv-dropdown" or "export-menu"), that inner div MUST
     carry ``position:absolute`` in its inline style.

  2. If such a helper div exists, the outer wrapper MUST carry
     ``position:relative`` in its inline style.

The pre-production row additionally includes a direct-child info div
(``#cost-pp-cmt-info``) that intentionally uses ``align-self:flex-end`` to
sit at the bottom of the row without being a field wrapper — it is excluded
from the per-wrapper checks (it has no label, no input).

Run with the stdlib test runner (no pytest required)::

    python -m unittest test_costing_field_alignment
"""
import os
import re
import unittest
from html.parser import HTMLParser


HTML_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                         "fabric_dashboard_live.html")

# ─────────────────────────────────────────────────────────────────────────────
# Minimal recursive HTML tree builder
# ─────────────────────────────────────────────────────────────────────────────

class _Node:
    """Thin wrapper around a parsed HTML element."""
    VOID = {"area","base","br","col","embed","hr","img","input",
            "link","meta","param","source","track","wbr"}

    def __init__(self, tag, attrs):
        self.tag = tag.lower()
        self.attrs = {k.lower(): (v or "") for k, v in attrs}
        self.children: list["_Node"] = []
        self.text = ""

    # convenience helpers
    @property
    def style(self) -> str:
        return self.attrs.get("style", "")

    @property
    def classes(self) -> list[str]:
        return self.attrs.get("class", "").split()

    @property
    def id(self) -> str:
        return self.attrs.get("id", "")

    def has_style(self, *tokens: str) -> bool:
        """True when ALL tokens appear in the inline style string."""
        s = self.style.replace(" ", "")
        return all(t.replace(" ", "") in s for t in tokens)

    def is_void(self) -> bool:
        return self.tag in self.VOID

    def __repr__(self) -> str:
        id_part = f" id={self.id!r}" if self.id else ""
        cls_part = f" class={' '.join(self.classes)!r}" if self.classes else ""
        return f"<{self.tag}{id_part}{cls_part} style={self.style!r}>"


class _TreeBuilder(HTMLParser):
    def __init__(self):
        super().__init__()
        self.root = _Node("_root", [])
        self._stack: list[_Node] = [self.root]

    def handle_starttag(self, tag, attrs):
        node = _Node(tag, attrs)
        self._stack[-1].children.append(node)
        if not node.is_void():
            self._stack.append(node)

    def handle_startendtag(self, tag, attrs):  # self-closing in XHTML
        self._stack[-1].children.append(_Node(tag, attrs))

    def handle_endtag(self, tag):
        tag = tag.lower()
        # pop up to the matching open tag
        for i in range(len(self._stack) - 1, 0, -1):
            if self._stack[i].tag == tag:
                self._stack = self._stack[:i]
                return

    def handle_data(self, data):
        if self._stack:
            self._stack[-1].text += data


def _parse_html(path: str) -> _Node:
    builder = _TreeBuilder()
    with open(path, encoding="utf-8") as f:
        builder.feed(f.read())
    return builder.root


# ─────────────────────────────────────────────────────────────────────────────
# Tree-walking helpers
# ─────────────────────────────────────────────────────────────────────────────

def _find_by_id(root: _Node, node_id: str) -> _Node | None:
    """BFS search for the first node with the given id."""
    queue = [root]
    while queue:
        n = queue.pop(0)
        if n.id == node_id:
            return n
        queue.extend(n.children)
    return None


def _is_dropdown(node: _Node) -> bool:
    """Dropdown menus are already positioned via CSS class — not a helper note."""
    dropdown_classes = {"resv-dropdown", "export-menu", "lc-po-dd"}
    return bool(set(node.classes) & dropdown_classes)


def _has_label(node: _Node) -> bool:
    """Does this wrapper contain an rsv-lbl label?"""
    for child in node.children:
        if child.tag == "label" and "rsv-lbl" in child.classes:
            return True
    return False


def _has_input_or_select(node: _Node) -> bool:
    """Does this wrapper contain an input or select?"""
    for child in node.children:
        if child.tag in ("input", "select"):
            return True
    return False


def _helper_divs_after_control(wrapper: _Node) -> list[_Node]:
    """Return block <div> children that appear AFTER the first input/select
    and are NOT dropdown menus — these are the helper/note elements."""
    found_control = False
    helpers = []
    for child in wrapper.children:
        if child.tag in ("input", "select"):
            found_control = True
            continue
        if found_control and child.tag == "div" and not _is_dropdown(child):
            helpers.append(child)
    return helpers


# ─────────────────────────────────────────────────────────────────────────────
# The test
# ─────────────────────────────────────────────────────────────────────────────

class CostingFieldAlignmentTest(unittest.TestCase):
    """Alignment invariant: helper divs inside costing flex rows must be
    positioned absolutely so they don't inflate the wrapper height."""

    @classmethod
    def setUpClass(cls):
        cls.root = _parse_html(HTML_PATH)

    # ── helper ──────────────────────────────────────────────────────────────

    def _check_row(self, row_node: _Node, row_label: str):
        """Walk every direct-child wrapper div of *row_node* and enforce the
        invariant: helper divs must be position:absolute; if present the
        wrapper must be position:relative."""
        violations = []

        for wrapper in row_node.children:
            if wrapper.tag != "div":
                continue  # only div wrappers matter

            # Skip direct-child info/status divs that have no label+input
            # (e.g. #cost-pp-cmt-info is an informational aside, not a field)
            if not _has_label(wrapper) or not _has_input_or_select(wrapper):
                continue

            helpers = _helper_divs_after_control(wrapper)
            if not helpers:
                continue  # no helper text → no alignment risk → OK

            wrapper_id = wrapper.id or repr(wrapper.style[:60])

            # Rule 1: every helper div must be position:absolute
            for h in helpers:
                if not h.has_style("position:absolute"):
                    helper_id = h.id or h.attrs.get("class", "")[:40]
                    violations.append(
                        f"[{row_label}] wrapper '{wrapper_id}': "
                        f"helper div '{helper_id}' is missing "
                        f"position:absolute (style={h.style!r}). "
                        f"Add position:absolute;top:100%;left:0 to avoid "
                        f"inflating the wrapper height and misaligning labels."
                    )

            # Rule 2: wrapper must be position:relative when helpers exist
            if not wrapper.has_style("position:relative"):
                violations.append(
                    f"[{row_label}] wrapper '{wrapper_id}' has helper "
                    f"div(s) but is missing position:relative on the wrapper "
                    f"(style={wrapper.style!r}). Without it the absolute "
                    f"helper will escape the wrapper bounds."
                )

        return violations

    # ── tests ────────────────────────────────────────────────────────────────

    def test_main_production_row_field_alignment(self):
        """Main Production flex row: no helper div inflates a field wrapper."""
        # The main row is the flex div directly inside #cost-editor that
        # contains the Style/StyleNumber/RetailPrice/Stage/DPS/Colour fields.
        # It is identified by a unique combination of its inline styles.
        cost_editor = _find_by_id(self.root, "cost-editor")
        self.assertIsNotNone(cost_editor,
                             "#cost-editor div not found in HTML")

        main_row = None
        for child in cost_editor.children:
            if (child.tag == "div"
                    and "flex" in child.classes
                    and "flex-wrap:wrap" in child.style.replace(" ", "")
                    and "align-items:flex-end" in child.style.replace(" ", "")
                    and "preproduction" not in child.id):
                main_row = child
                break

        self.assertIsNotNone(main_row,
                             "Could not find the main-production flex row "
                             "inside #cost-editor. Check that the row still "
                             "has class='flex' and style contains "
                             "align-items:flex-end.")

        violations = self._check_row(main_row, "Main Production")
        self.assertFalse(
            violations,
            "Costing sheet Main Production row has helper-text alignment "
            "violations:\n" + "\n".join(violations)
        )

    def test_preproduction_row_field_alignment(self):
        """Pre-production flex row: no helper div inflates a field wrapper."""
        pp_row = _find_by_id(self.root, "preproduction-fields")
        self.assertIsNotNone(pp_row,
                             "#preproduction-fields div not found in HTML")

        self.assertIn("flex", pp_row.classes,
                      "#preproduction-fields must keep class='flex' "
                      "for the alignment invariant to apply")

        violations = self._check_row(pp_row, "Pre-production")
        self.assertFalse(
            violations,
            "Costing sheet Pre-production row has helper-text alignment "
            "violations:\n" + "\n".join(violations)
        )

    def test_both_rows_have_align_items_flex_end(self):
        """Both flex rows must keep align-items:flex-end for bottom-alignment.

        If this style is removed the whole basis for the label-top alignment
        changes and the helper-text fix stops being meaningful.
        """
        cost_editor = _find_by_id(self.root, "cost-editor")
        self.assertIsNotNone(cost_editor, "#cost-editor not found")

        main_row = None
        for child in cost_editor.children:
            if (child.tag == "div"
                    and "flex" in child.classes
                    and "align-items:flex-end" in child.style.replace(" ", "")
                    and "preproduction" not in child.id):
                main_row = child
                break

        self.assertIsNotNone(main_row,
                             "Main production row must exist with "
                             "align-items:flex-end")

        pp_row = _find_by_id(self.root, "preproduction-fields")
        self.assertIsNotNone(pp_row, "#preproduction-fields not found")
        self.assertIn(
            "align-items:flex-end",
            pp_row.style.replace(" ", ""),
            "#preproduction-fields must keep align-items:flex-end "
            "in its inline style"
        )

    def test_known_helper_divs_are_absolutely_positioned(self):
        """Spot-check: the two known helper divs that were the original source
        of misalignment are confirmed absolutely positioned."""
        sp_exvat = _find_by_id(self.root, "cost-sp-exvat")
        self.assertIsNotNone(sp_exvat,
                             "#cost-sp-exvat helper div not found")
        self.assertTrue(
            sp_exvat.has_style("position:absolute"),
            f"#cost-sp-exvat must have position:absolute (got {sp_exvat.style!r})"
        )

        acc_note = _find_by_id(self.root, "cost-pp-acc-note")
        self.assertIsNotNone(acc_note,
                             "#cost-pp-acc-note helper div not found")
        self.assertTrue(
            acc_note.has_style("position:absolute"),
            f"#cost-pp-acc-note must have position:absolute (got {acc_note.style!r})"
        )

    def test_known_helper_wrappers_are_relatively_positioned(self):
        """Spot-check: wrappers that own an absolutely-positioned helper must
        themselves be position:relative."""
        cost_editor = _find_by_id(self.root, "cost-editor")
        self.assertIsNotNone(cost_editor)

        # Locate the main-production flex row (direct child of #cost-editor).
        main_row = None
        for child in cost_editor.children:
            if (child.tag == "div"
                    and "flex" in child.classes
                    and "align-items:flex-end" in child.style.replace(" ", "")
                    and "preproduction" not in child.id):
                main_row = child
                break
        self.assertIsNotNone(main_row,
                             "Could not locate main-production flex row")

        # #cost-sp-exvat lives inside the Retail-price field wrapper, which is
        # a direct child of the main flex row.
        sp_wrapper = self._find_parent_containing_id(
            main_row, "cost-sp-exvat")
        self.assertIsNotNone(sp_wrapper,
                             "Could not find field wrapper of #cost-sp-exvat "
                             "in the main-production row")
        self.assertTrue(
            sp_wrapper.has_style("position:relative"),
            f"Wrapper of #cost-sp-exvat must be position:relative "
            f"(got style={sp_wrapper.style!r})"
        )

        # #cost-pp-acc-note is inside the Accessories-% wrapper, a direct
        # child of the pre-production row.
        pp_row = _find_by_id(self.root, "preproduction-fields")
        acc_wrapper = self._find_parent_containing_id(pp_row, "cost-pp-acc-note")
        self.assertIsNotNone(acc_wrapper,
                             "Could not find field wrapper of #cost-pp-acc-note")
        self.assertTrue(
            acc_wrapper.has_style("position:relative"),
            f"Wrapper of #cost-pp-acc-note must be position:relative "
            f"(got style={acc_wrapper.style!r})"
        )

    # ── internal utility ─────────────────────────────────────────────────────

    def _find_parent_containing_id(self, scope: _Node, target_id: str) \
            -> _Node | None:
        """Return the direct child of *scope* whose subtree contains a node
        with *target_id*.  Returns None if not found."""
        for child in scope.children:
            if _find_by_id(child, target_id) is not None:
                return child
        return None


if __name__ == "__main__":
    unittest.main()
