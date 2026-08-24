---
name: Deployment image 8 GiB limit
description: Publish fails with "image size is over the limit of 8 GiB" — cause, biggest offenders in this workspace, and what is safe to delete
---

**Rule:** The publish image packages roughly the whole workspace (dotdirs included). When the build log ends with `image size is over the limit of 8 GiB: total size of layers exceeds limit`, every app build succeeded — the fix is purely to shrink the workspace, then republish.

**Why:** Hit Aug 2026: workspace had grown to 9.0G. Biggest offenders were pure dev bloat: `.config/.vscode-server` (3.1G, desktop-editor cache that regrows with use), `.local/share/pnpm` store (1.1G), legacy `dashboard/node_modules` (1.1G), `.cache/*` (0.7G), `loyalty-app/*/node_modules` (0.55G). Deleting all of these took it to 2.6G with zero runtime impact.

**How to apply:**
- Diagnose with `du -xsh * .[!.]*` at workspace root — remember `du dir/*` misses dot-children (`.config` looked 151M until `.config/.[!.]*` revealed vscode-server).
- Safe to delete anytime: `.config/.vscode-server` (may need 2 rm passes while an editor is connected), `.config/npm`, `.cache/{pnpm,typescript,uv,node-gyp,prisma,jedi,pip}`, `dashboard/node_modules` (legacy app, nothing runs it), `loyalty-app/*/node_modules` (nothing runs the node backend; the Python API serves `the-loyalty-app/build/client`, and deployment build never rebuilds loyalty-app).
- `.local/share/pnpm` (store) is safe too: root `node_modules` files are hardlinks, so deleting the store leaves them working (dev servers verified fine after).
- Keep `.local/state/replit` (platform state), root `node_modules`, `.pythonlibs`,
  and `attached_assets` available during development. For publishing, exclude
  `.config`, `.git`, and `**/node_modules` with `.replitignore` rather than
  deleting local dependencies; the managed build reinstalls what it needs.
