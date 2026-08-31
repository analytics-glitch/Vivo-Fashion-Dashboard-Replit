# Vivo Johari mobile release checklist

This target is a native shell around the existing Vivo Community website. The
web app remains the source of truth for Home, Shop, Community, Rewards,
Account, legal/help, referrals, and destination deep links. The shell keeps
the opaque member token in the platform secure store and restores it into the
website only at launch.

## Identity

| Platform | Value |
| --- | --- |
| App name | Vivo Johari |
| Android package | `com.vivofashiongroup.johari` |
| iOS bundle ID | `com.vivofashiongroup.johari` |
| Deep-link scheme | `vivo-johari://app` |
| Initial version | `1.0.0` |

The web route used by every store/release build is hard-locked to
`https://vivofashionbrands.com/app/`; release builds ignore environment URL
overrides so a configuration mistake cannot send a member token to another
origin. `EXPO_PUBLIC_COMMUNITY_URL` is honored only by a development bundle.
It must include the `/app/` route so the website's own API paths continue to
resolve through the shared backend.

## Release configuration

`app.json` contains the production identifiers, version/build numbers, splash
screen, adaptive icon, deep-link intent filter, and camera/photo/location/
microphone permission copy. `eas.json` contains:

- `development` for an internal development client
- `preview` for internal Android App Bundle and iOS device builds
- `production` for store Android App Bundle and iOS distribution archives

Run the reproducible local release gate before handing the target to Expo
Launch:

```bash
pnpm --filter @workspace/vivo-community-mobile run release:validate
pnpm --filter @workspace/vivo-community-mobile exec expo config --type public
```

The first command type-checks and creates the static Expo preview bundle. Expo
Launch then produces the signed Android App Bundle and iOS archive using the
`production` profile. Android publishing and Play Console administration remain
the account owner's responsibility; Replit does not publish Android apps.

## Owner actions in Expo Launch / stores

1. Confirm the package and bundle identifiers are available in the owner
   accounts; do not change them after the first build.
2. Add the Apple Developer team and App Store Connect app ID in Expo Launch.
3. Create or select the Android signing key and upload key in the owner's
   Google Play Console.
4. Replace the placeholder customer-care values in the Community web app
   before submission; the native shell intentionally does not hide those
   website-provided actions.
5. Complete store listing metadata: Vivo Johari name, description, support URL,
   privacy-policy URL, category, age rating, screenshots, and the generated
   icon/splash assets.
6. Complete the privacy declarations. The app processes account/contact
   details, phone verification, shopping activity, community submissions,
   referrals, rewards activity, and user-selected photos/videos for the
   stated Community features. Try-on and upload photos are member-owned,
   consent-gated where applicable, and deletable from the app.
7. Verify the production build against the checklist below on a physical
   Android device and an iPhone before submission.

## Mobile release checks

- Signed out: launch, welcome screen, legal/help pages, phone/OTP validation,
  and guest browsing.
- Guest: Home and Shop are readable; member-only writes and Rewards/Account
  actions show the sign-in gate.
- Signed in: restore after relaunch, Shop filters/PDP, bag and wishlist
  isolation, Community comments/likes/entries, Rewards, Account, referral,
  My Data, and sign out.
- Deep links: `vivo-johari://app?ref=CODE`,
  `vivo-johari://app?tab=community&sub=events`, product/event/article/page
  query destinations, and supported website links.
- Device behavior: hardware back and iOS swipe-back, safe areas, keyboard
  visibility, external maps/phone/email/WhatsApp links, and native share sheet.
- Media: choose from the photo library, take a camera photo, upload a
  community entry or try-on photo, delete it, and confirm guest/member and
  ownership/consent gates remain enforced.
- Failure recovery: airplane-mode launch shows a retry action, the secure
  member token is not exposed in URLs, and sign out clears token, guest state,
  bag/wishlist storage, and session storage.