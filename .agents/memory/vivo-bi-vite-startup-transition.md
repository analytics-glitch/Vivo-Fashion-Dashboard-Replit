---
name: Vivo BI Vite startup listener transition
description: Why the managed Vivo BI wrapper must treat an empty-to-listening port transition as normal startup, then verify the completed marked chain.
---

**Rule:** During the managed Vivo BI wrapper's own child startup, do not fail merely because port 18659 changes from no listener to one listener. Wait for one stable listener, write the listener identity into the run-owned record, and then require the normal marked-owner proof before accepting it.

**Why:** Vite commonly binds between two port polls. The generic stable-listener helper correctly flags that change during takeover/recovery, but applying that recovery rule to a newly spawned child kills the valid pnpm/Vite chain during its normal boot.

**How to apply:** Keep strict stable-listener checks for existing-owner and legacy-recovery decisions. Use the startup-specific wait only after this wrapper has launched its own pnpm child, and retain the full marked listener/owner/ancestry proof before declaring startup healthy.