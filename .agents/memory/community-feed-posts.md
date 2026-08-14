---
name: Community feed posts (interactive)
description: DB-backed feed posts with likes/comments/reports — seeding rules, the no-points rule, count reconciliation, moderation flow, mobile overlay scroll/gesture canon, e2e scroll-testing traps
---

- Feed posts were promoted from mocks: `community_feed_posts` is seeded per `mock_key` with `ON CONFLICT DO NOTHING` on every boot, so a partial table self-completes (prod separate-DB / partial-import safe; proven by deleting a row and rebooting). Tagged product chips self-heal from the live catalogue on later boots (to_regclass probe — no try/except inside _ensure_tables' transaction). Seeding runs via lazy table init: it fires on the first community API hit, not at port bind. Post authors are denormalized fictional showcase identities, NOT community_members rows.
- **Likes and comments earn NO points** — deliberate anti-spam decision. Any future feed interaction must not write `community_points_events` (smoke asserts zero delta).
- `like_count` = `like_seed` + real like rows; toggle is delete-then-insert; `my_liked` needs optional auth (sentinel member id for anonymous readers).
- Moderation: comments publish instantly; Report → open flag in the CRM Community Inbox queue; Remove sets `status='removed'` (never DELETE) and resolves reports; Dismiss keeps the comment. Report action hidden on own comments client-side only.

**Why:** points-for-engagement invites spam; seed counts keep the feed alive pre-launch; instant publish + report-driven moderation beats pre-moderation for a small community.

**How to apply:** card and modal share ONE feed list per tab, patched by post id (`onCounts`). The thread endpoint returns ALL visible comments, so thread length is truth — reconcile the card's `comment_count` from it on every load (heals staleness after a CRM removal). Comment submit must be post-scoped: capture post id + view sequence at send, only touch the visible thread if still on that post, and bump the sequence so an in-flight thread fetch can't clobber the appended comment.

## Mobile full-screen overlay canon (portal modals)
- `overflow:hidden` body lock is NOT enough on mobile — the browser clamps `window.scrollY` to 0 as soon as the full-screen portal commits, BEFORE even a layout effect runs. Use the position-fixed lock: `body { position:fixed; top:-y; width:100% }` applied in `useLayoutEffect` (pre-paint, so no visible jump), restore styles + `scrollTo(0,y)` + one `requestAnimationFrame` re-assert on unmount. While locked, `scrollY` reading 0 is CORRECT behavior, not a bug.
- Capture the restore Y **in the tap handler** (parent passes `restoreY` prop) — modal-side capture is too late.
- Tall tap targets (`tabIndex` cards): native tap-focus scrolls the element into alignment BEFORE `click` fires — corrupting any capture and visibly jumping the page. `onPointerDown={(e) => e.preventDefault()}` suppresses tap-focus only; click, touch scrolling, and keyboard focus/Enter keep working. Small targets (grid tiles) don't trigger it, which hides the bug in some flows.
- Swipe nav: `touch-action: pan-y` on the panel, track last position from `touchmove`, handle `touchcancel`; add a pointer-drag fallback (`pointerType !== "touch"`) on the visual pane only (never on selectable text).

## E2E scroll-testing traps (Playwright harness)
- Actionability AUTO-SCROLLS off-screen targets into view before tap — tapping `grid-post-1` after scrolling down "breaks" scroll restore with a bare no-caller scroll event. Test restoration only with in-view targets (pick via `document.elementFromPoint(...).closest('[data-testid^=...]')`).
- Synthetic touch swipes may never register; verify swipe via the pointer-drag fallback and trust real devices for touch.
- To attribute scroll movement, wrap `window.scrollTo` logging args+stack plus a passive scroll listener: bare scroll-events = native/browser (focus-scroll, clamp, harness), stack-bearing entries = app code.
