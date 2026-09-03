---
name: Johari notification consent
description: Durable rules for notification permission prompts in the Johari Expo shell.
---

Johari notification consent has two independent states: whether the member dismissed the app's explanatory prompt, and the phone's actual notification permission. The Expo shell owns both the OS request and Settings deep-link; the WebView may only signal trusted lifecycle or reward moments.

**Why:** Treating “Not now” as an OS denial either repeats the full onboarding gate or suppresses useful later nudges. Treating cached permission as authoritative also breaks when a member changes permission in Settings or upgrades from an older app version.

**How to apply:** Reconcile notification permission with the OS on every native evaluation. Evaluate the initial gate both when a fresh auth-token bridge message arrives and when a SecureStore token restores a session at shell startup—the restored-token path emits no new bridge message. Show the full gate only before soft dismissal, use a lightweight contextual prompt after a confirmed reward, never retry a permanently denied native dialog, and route later denial nudges to app Settings.