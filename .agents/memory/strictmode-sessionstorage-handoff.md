---
name: One-shot storage hand-offs (tap-only + double-mount safety)
description: sessionStorage hand-offs never fire on URL navigation — e2e must tap the real entry point; module-scope stash for double-mount safety
---
Two rules for one-shot sessionStorage hand-offs (e.g. PDP → Try-On garment preselect):

1. **They are tap-only by design.** The key is written in the tap handler, so URL/goto/deep-link navigation to the destination NEVER carries the hand-off — the destination correctly falls back to its neutral state. An e2e run that navigates by URL will report the hand-off "broken" when it was simply never invoked.
   **How to apply:** e2e verification of any hand-off must drive the real entry-point tap, never a composed URL; a deep-link showing the neutral state is correct behavior. When a tester reports a hand-off failure, first establish whether the run tapped or goto'd — instrument with console.debug tracing at each link (tap handler → mount read → resolve) and demand the verbatim lines.

2. **Consume double-mount-safely.** Reading AND removing the key inline in a mount effect lets a discarded pass (StrictMode dev double-mount, or any quick remount) eat the key before the surviving pass runs.
   **How to apply:** move the key to module scope immediately (`let _pending` beside the key constant); the effect reads the module var, and only the pass that survives to the async resolve clears it.

**Why:** the community app's PDP→Try-On preselect was reported broken in two consecutive e2e rounds; an instrumented, tap-choreographed rerun showed the whole chain firing perfectly — the failing runs had navigated by URL. The code was never broken.
