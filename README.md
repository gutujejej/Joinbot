# Task & Rewards bot platform (join channels, earn ETB)

A separate system from your P2P, Bingo and Store projects: its own tables (all start with `jb_`), its own server, its own bots.

**Users** start a bot, pass a captcha, join channels, invite friends, do tasks, and request a withdrawal of their ETB reward balance. **Admins** run everything inside a Telegram Mini App. **You (the controller)** create bots and choose each bot's admin; the admin never sees you.

## What is in it
- **Captcha**: pick-the-animal or simple math, easy/normal/hard, time limit, tries, cooldown after failures, optional phone-number check (own number only, country prefix, one account per number).
- **Tasks**: join a channel or group (checked with `getChatMember`), daily check-in, visit a page (timer), custom task (admin approves the proof). Reward, max participants, daily limit, start and end dates, pause/archive. A reward is credited exactly once.
- **Referrals**: unique link, no self-referral, reward only after the friend passes the check and finishes N tasks (admin sets N), cap per user, campaign bonuses.
- **Wallet**: available, pending (reserved), lifetime, withdrawn, task and referral earnings. Every change is a row in an append-only ledger. All balance changes run inside SQL functions with row locks, so parallel taps cannot double-pay.
- **Withdrawals**: minimum, maximum, fee (% + flat), methods, one open request at a time. Statuses pending, approved, processing, paid, rejected. Paid needs a payment reference. Rejected needs a reason and releases the amount.
- **Scheduled posts**: connect channels/groups, text + photo/video + button, preview, date and time in your time zone, repeat daily/weekly, calendar and list, edit, cancel, retry failed chats, history. A retry never posts twice.
- **Broadcasts**: all / verified / active / people who did a task, preview to yourself, schedule, cancel, sent and failed counts, about 20 messages a second, blocked users are marked, confirmation for large sends.
- **Admin panel**: dashboard with a 14-day chart, users, task proofs, withdrawals, tasks, channels, campaigns, posts, broadcasts, banners, support tickets, alerts, audit log, CSV reports, settings, admins and roles.
- **Roles**: owner, administrator, finance manager, moderator, support agent.
- **Safety**: signed Mini App data checked on the server, tokens encrypted (AES-256-GCM), per-bot webhook secret, rate limits, audit log (the controller shows as "platform"), fraud alerts (rapid claims, referral bursts, repeated captcha failures, duplicate phones, people who leave channels), account hold for review.
- **Languages**: English and a first-draft Amharic for the main screens. Please have a native speaker check it.

## Differences from the spec you sent
- **Stack**: Node.js + Express + Supabase Postgres + single-file HTML mini app, instead of React/Vite/TypeScript/Tailwind/Prisma/BullMQ/Redis. Reason: I could not install packages where I built this, so a TypeScript/React build could not be run or tested; this version was fully tested. No Redis to pay for. Background jobs run inside the server (use one instance). It can be converted later.
- **Uploads**: images and videos are https links (or Telegram file ids). S3 upload is not built.
- **Bot profile picture**: Telegram does not let bots change it by API. Set it in BotFather. Name and description are set from the panel.
- **Live updates**: the panel refreshes when you open a tab; there are no WebSockets.
- **Not built yet**: scheduled-report emails, user data-deletion tool, per-event notification switches, richer manual-review screens, pagination beyond the first 20 users. Say the word and I will add them.
- Rewards are promotional credits. The app never says money was sent. A withdrawal is only "paid" after an admin enters a real payment reference.
- A user who leaves a channel is handled by the published rule only: if you switch on "reverse reward on leave", a new reversal row is added, the user is told, and nothing old is edited.

## Setup
1. **Supabase**: SQL editor, run `schema.sql` once.
2. **Environment** (see `.env.example`): `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `PUBLIC_URL` (https), `TOKEN_KEY` (long random secret: `openssl rand -hex 32`, never change it after bots are connected), `SUPER_ADMIN_IDS` (your Telegram id), `FACTORY_BOT_TOKEN` (a bot you create in BotFather just for you).
3. **Deploy** this folder as its own service (for example Railway: new service, root directory `joinbot`, start command `npm start`). Use one instance. Never put the service key in frontend code.
4. Open your factory bot and send /start. Send it a BotFather token to create a system. Then `/addadmin BOT_ID ADMIN_TELEGRAM_ID owner`.
5. The admin opens their bot and sends /admin (or taps the menu button). In **Tasks > Channels** they add the bot as admin of each channel first, then connect it, then create join tasks.
6. Optional: `BOT_ID=1 npm run seed` adds sample banners/tasks.

## Tests
`npm test` runs 148 checks against an in-memory copy of the database and a fake Telegram: wallet and reward maths, duplicate and parallel claims, referrals, captcha lock-out, withdrawals, roles, posts, broadcasts, reversals, token rotation.

## Honest limits
- `schema.sql` was written carefully but I had no Postgres here, so it is **not yet run against a real database**. Run it in Supabase and send me any error text.
- Nothing was tried against live Telegram. Expect small fixes on first run.
- Telegram needs the bot to be an admin of a channel to read its members. A private invite link joiner is checked the same way.
