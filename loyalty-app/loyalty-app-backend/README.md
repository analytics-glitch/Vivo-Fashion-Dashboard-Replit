# ZETU Loyalty — Backend (Fastify)

See the [root README](../README.md) for full setup. This is the API reference.

## Run

```bash
cp .env.example .env
npm install
npm run db:up && npm run prisma:migrate && npm run db:seed
npm run dev          # http://localhost:4001
```

## API

Base: `/api` · Auth: JWT in an httpOnly cookie (`credentials: include`).

### Auth
| Method | Path | Auth | Body |
| --- | --- | --- | --- |
| GET | `/auth/status` | — | — |
| GET | `/auth/me` | ✅ | — |
| POST | `/auth/logout` | — | — |
| GET | `/auth/google` | — | `?ref&next` → redirects to Google |
| GET | `/auth/google/callback` | — | OAuth callback → sets cookie, redirects to web |
| POST | `/auth/google/token` | — | `{ credential, referralCode? }` (One-Tap) |
| POST | `/auth/otp/request` | — | `{ email }` |
| POST | `/auth/otp/verify` | — | `{ email, code, referralCode? }` |

### Loyalty
| Method | Path | Body |
| --- | --- | --- |
| GET | `/loyalty/profile` | — |
| PATCH | `/loyalty/profile` | `{ firstName?, lastName?, phone?, birthday? }` |
| GET | `/loyalty/points/history` | `?cursor&limit` |
| POST | `/loyalty/bonus/birthday` | — |

### Rewards
| Method | Path | Body |
| --- | --- | --- |
| GET | `/rewards` | — (public catalogue) |
| GET | `/rewards/redemptions` | — |
| POST | `/rewards/:rewardId/redeem` | — → issues Shopify discount code |

### Shopify
| GET | `/shopify/orders` · `/shopify/returns` | live from Admin API |

### Referrals
| GET | `/referrals` · POST | `/referrals/invite` `{ email }` |

### Webhooks (raw body, HMAC-verified)
`POST /webhooks/shopify/orders-paid` · `POST /webhooks/shopify/refunds-create`

## Data model

`Customer`, `Tier`, `PointsTransaction` (ledger), `Reward`, `Redemption`, `Referral`,
`OtpCode`, `ProcessedWebhook`. See [`prisma/schema.prisma`](prisma/schema.prisma).

Points flow through [`src/lib/loyalty.ts`](src/lib/loyalty.ts) (`awardPoints` / `spendPoints`)
so the ledger stays the source of truth and the cached balance is always consistent.
