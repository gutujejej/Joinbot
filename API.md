# API reference

All calls need the header `X-Init-Data: <Telegram.WebApp.initData>`. The server verifies the Telegram signature with the bot's own token and rejects data older than 24 hours. The user id always comes from that signed data, never from the request body.

Base: `/jb/api/:botId`. Errors are `{ "error": "message" }` with 400, 401, 403, 404, 429 or 503.

## User
| Method | Path | What it does |
|---|---|---|
| GET | `/home` | profile, balances, tasks with status, announcements, campaign, referral stats, recent activity, public settings |
| POST | `/tasks/:id/claim` | claim a task. Join tasks are checked with getChatMember. Body: `{proof}` for custom tasks |
| POST | `/tasks/:id/visit` | start the timer of a visit task |
| POST | `/verify` | verify every open channel task at once |
| GET | `/wallet` | balances, ledger (50), withdrawals (20) |
| POST | `/withdraw` | `{amount, method, account}`. Amount is reserved immediately |
| POST | `/me` | `{lang, notify}` |
| GET | `/leaderboard?by=earn|tasks|referrals` | top 20 |
| POST / GET | `/tickets` | create / list my support tickets |

## Admin (role needed in brackets)
Roles: owner (everything), admin, finance, moderator, support.

| Method | Path | Role permission |
|---|---|---|
| GET | `/a/stats` | dashboard |
| GET | `/a/users?q=&filter=&page=` , GET `/a/users/:id` | users |
| POST | `/a/users/:id/ban` `{banned}` , `/review` `{review}` , `/reset-captcha` | users |
| POST | `/a/users/:id/adjust` `{amount, reason}` (reason required) | finance |
| GET POST DELETE | `/a/channels` (POST `{ref}` checks the bot is admin there) | tasks |
| GET POST PUT DELETE | `/a/tasks` (DELETE archives) | tasks |
| GET | `/a/claims` , POST `/a/claims/:id/approve` or `reject` | review |
| GET | `/a/withdrawals?status=open|paid|rejected` | finance |
| POST | `/a/withdrawals/:id/status` `{status, note, pay_ref}` | finance |
| GET POST PUT DELETE | `/a/posts` , POST `/a/posts/:id/send-now` , `/retry` , GET `/history` | posts |
| GET POST | `/a/broadcasts` , POST `/preview` , `/:id/cancel` | broadcast |
| GET PUT | `/a/settings` (also bot name, description, status) | settings |
| POST | `/a/token` `{token}` | admins |
| GET POST DELETE | `/a/admins` | admins |
| GET | `/a/audit` | audit |
| GET POST | `/a/flags` | flags |
| GET POST DELETE | `/a/announcements` | settings |
| GET POST DELETE | `/a/campaigns` | campaigns |
| GET POST | `/a/tickets` , `/a/tickets/:id/reply` , `/close` | support |
| GET | `/a/export/users|ledger|withdrawals` (CSV) | finance |

Withdrawal statuses: `pending -> approved -> processing -> paid`, and `rejected` from any open state (releases the reserved amount). `paid` needs a payment reference. `rejected` needs a reason.

## Controller (platform owner)
Base `/jb/ctl`, signed with the controller bot's token, only for ids in `SUPER_ADMIN_IDS`.
`GET /bots`, `POST /bots {token}`, `POST /bots/:id/admins {tg_id, role}`, `POST /bots/:id/status {status}`, `POST /bots/:id/token {token}`.

## Telegram webhooks
`POST /jb/hook/:botId` (header `X-Telegram-Bot-Api-Secret-Token` must match that bot's secret) and `POST /jb/factory/:secret`.
