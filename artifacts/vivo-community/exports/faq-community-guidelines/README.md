# Vivo Community FAQ & Community Guidelines export

This folder is a source-and-content export of the two `/app/` pages, prepared
from the live Vivo Community implementation. The wording in the Markdown files
is a readable rendering of the current data source; it has not been rewritten,
proofread, or legally approved.

## Files

- `FAQ.md` — content-only FAQ export, in the same section and question order as
  `FAQ_SECTIONS`.
- `COMMUNITY-GUIDELINES.md` — content-only Community Guidelines export, in the
  same section and block order as `GUIDELINES_SECTIONS`.
- `TERMS-AND-CONDITIONS.md` — content-only Terms & Conditions export, in the
  same section and block order as `TERMS_SECTIONS`.
- `PRIVACY-POLICY.md` — content-only Privacy Policy export, in the same section
  and block order as `PRIVACY_SECTIONS`.
- `source/HelpFaqView.jsx` — snapshot of the component that renders the FAQ
  page, including search, accordion behavior, contact CTA, and formal-document
  links.
- `source/LegalPage.jsx` — snapshot of the shared legal-page renderer. The
  `guidelines` document entry is the one used for Community Guidelines; the
  renderer also retains its existing Terms and Privacy document entries.
- `source/legalData.js` — snapshot of the shared content source. The FAQ is
  driven by `FAQ_SECTIONS`; Community Guidelines are driven by
  `GUIDELINES_SECTIONS`.

## Live entry points

In the app, `CommunityShell.jsx` opens `HelpFaqView` when the page id is
`faq`, and opens `LegalPage` for the `guidelines` page id. `AuthFlow.jsx`
exposes the same two views in the unauthenticated help/legal flow.

## Existing dependencies

The source snapshots intentionally keep the live imports unchanged:

- Both components use React and `lucide-react`.
- `HelpFaqView.jsx` imports `FAQ_SECTIONS` from `legalData.js` and visual
  utility class names (`cardCls`, `inputCls`, `btnPrimary`) from the sibling
  `ui.jsx` module.
- `LegalPage.jsx` imports the legal metadata and section arrays from
  `legalData.js`.
- Running these JSX snapshots as app code also needs the Vivo Community
  package/tooling in `package.json` (React, Vite, and the configured Tailwind
  classes). The snapshots are provided for reuse/reference; they are not
  imported by the live app.

## Source relationship

`source/legalData.js` is the content source of truth for this export. If the
live `legalData.js` changes, regenerate both Markdown files from the updated
`FAQ_SECTIONS` and `GUIDELINES_SECTIONS` entries and keep the source snapshots
in sync. The live files under
`src/components/community/` are deliberately unchanged by this export.