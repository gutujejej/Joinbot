-- Task & Rewards bot platform (multi-tenant). Run once in the Supabase SQL editor. Safe to run again.
-- Only creates new tables/functions starting with jb_. It does not touch any other table.

create table if not exists jb_bots (
  id          bigint generated always as identity primary key,
  tg_id       bigint not null unique,
  username    text,
  name        text,
  description text,
  token_enc   text   not null,                 -- bot token, AES-256-GCM encrypted by the backend
  token_last4 text,
  secret      text   not null,                 -- webhook secret
  status      text   not null default 'active' check (status in ('active','paused')),
  settings    jsonb  not null default '{}'::jsonb,
  created_by  bigint,                          -- controller (platform owner). Never shown to bot admins.
  created_at  timestamptz not null default now()
);

create table if not exists jb_admins (
  bot_id   bigint not null references jb_bots(id) on delete cascade,
  tg_id    bigint not null,
  role     text   not null default 'admin' check (role in ('owner','admin','finance','moderator','support')),
  added_at timestamptz not null default now(),
  primary key (bot_id, tg_id)
);

create table if not exists jb_users (
  bot_id        bigint not null references jb_bots(id) on delete cascade,
  tg_id         bigint not null,
  username      text,
  first_name    text,
  lang          text,
  captcha       jsonb,
  captcha_ok    boolean not null default false,
  captcha_fails int     not null default 0,
  cooldown_until timestamptz,
  phone         text,
  banned        boolean not null default false,
  blocked       boolean not null default false,
  review        boolean not null default false,     -- held for manual review
  notify        boolean not null default true,
  balance       numeric(14,2) not null default 0 check (balance >= 0),   -- available
  pending       numeric(14,2) not null default 0 check (pending >= 0),   -- reserved by withdrawal requests
  total_earned  numeric(14,2) not null default 0,
  earned_task   numeric(14,2) not null default 0,
  earned_ref    numeric(14,2) not null default 0,
  withdrawn_total numeric(14,2) not null default 0,
  state         jsonb,
  joined_at     timestamptz not null default now(),
  last_seen     timestamptz not null default now(),
  primary key (bot_id, tg_id)
);
create index if not exists jb_users_joined_idx on jb_users (bot_id, joined_at);
create unique index if not exists jb_users_phone_uq on jb_users (bot_id, phone) where phone is not null;

create table if not exists jb_referrals (
  bot_id       bigint not null references jb_bots(id) on delete cascade,
  referred_id  bigint not null,
  referrer_id  bigint not null,
  status       text not null default 'pending' check (status in ('pending','qualified','rejected')),
  reward       numeric(14,2) not null default 0,
  created_at   timestamptz not null default now(),
  qualified_at timestamptz,
  primary key (bot_id, referred_id)
);
create index if not exists jb_ref_referrer_idx on jb_referrals (bot_id, referrer_id, status);

create table if not exists jb_channels (
  id           bigint generated always as identity primary key,
  bot_id       bigint not null references jb_bots(id) on delete cascade,
  chat_id      bigint not null,
  title        text   not null,
  username     text,
  invite_link  text,
  kind         text   not null default 'channel',
  last_error   text,
  created_at   timestamptz not null default now(),
  unique (bot_id, chat_id)
);

create table if not exists jb_tasks (
  id               bigint generated always as identity primary key,
  bot_id           bigint not null references jb_bots(id) on delete cascade,
  type             text   not null check (type in ('join','daily','visit','custom')),
  title            text   not null,
  description      text,
  channel_id       bigint references jb_channels(id) on delete set null,
  chat_id          bigint,
  username         text,
  url              text,                         -- invite link / page to visit / instructions link
  reward           numeric(14,2) not null default 0 check (reward >= 0),
  max_participants int,
  daily_limit      int,
  min_seconds      int not null default 10,      -- visit tasks: minimum time before claiming
  requires_review  boolean not null default false,
  starts_at        timestamptz,
  expires_at       timestamptz,
  status           text not null default 'active' check (status in ('active','paused','archived')),
  sort             int not null default 0,
  participants_count int not null default 0,
  created_at       timestamptz not null default now()
);
create index if not exists jb_tasks_bot_idx on jb_tasks (bot_id, status, sort);

create table if not exists jb_task_claims (
  id          bigint generated always as identity primary key,
  bot_id      bigint not null references jb_bots(id) on delete cascade,
  task_id     bigint not null references jb_tasks(id) on delete cascade,
  user_id     bigint not null,
  day_key     text   not null default '',
  status      text   not null default 'approved' check (status in ('pending','approved','rejected','reversed')),
  proof       text,
  reward      numeric(14,2) not null default 0,
  created_at  timestamptz not null default now(),
  decided_at  timestamptz,
  decided_by  bigint,
  checked_at  timestamptz,
  unique (task_id, user_id, day_key)
);
create index if not exists jb_claims_user_idx on jb_task_claims (bot_id, user_id, created_at desc);
create index if not exists jb_claims_review_idx on jb_task_claims (bot_id, status, created_at);

create table if not exists jb_ledger (
  id          bigint generated always as identity primary key,
  bot_id      bigint not null,
  user_id     bigint not null,
  amount      numeric(14,2) not null,        -- + credit, - debit. Rows are never edited or deleted.
  kind        text   not null,               -- task, daily, referral, adjust, withdraw, refund, reversal
  ref_key     text,
  note        text,
  created_at  timestamptz not null default now()
);
create unique index if not exists jb_ledger_once_uq on jb_ledger (bot_id, user_id, kind, ref_key) where ref_key is not null;
create index if not exists jb_ledger_user_idx on jb_ledger (bot_id, user_id, created_at desc);

create table if not exists jb_withdrawals (
  id           bigint generated always as identity primary key,
  bot_id       bigint not null references jb_bots(id) on delete cascade,
  user_id      bigint not null,
  amount       numeric(14,2) not null check (amount > 0),
  fee          numeric(14,2) not null default 0,
  net          numeric(14,2) not null,
  method       text not null,
  account      text not null,
  status       text not null default 'pending' check (status in ('pending','approved','processing','paid','rejected')),
  note         text,
  pay_ref      text,
  created_at   timestamptz not null default now(),
  resolved_at  timestamptz,
  resolved_by  bigint
);
create index if not exists jb_wd_idx on jb_withdrawals (bot_id, status, created_at desc);
create index if not exists jb_wd_user_idx on jb_withdrawals (bot_id, user_id, created_at desc);

create table if not exists jb_posts (
  id           bigint generated always as identity primary key,
  bot_id       bigint not null references jb_bots(id) on delete cascade,
  text         text,
  media_type   text not null default 'none' check (media_type in ('none','photo','video')),
  media_url    text,
  button_text  text,
  button_url   text,
  targets      bigint[] not null default '{}',   -- jb_channels ids
  run_at       timestamptz not null,
  repeat       text not null default 'none' check (repeat in ('none','daily','weekly')),
  status       text not null default 'scheduled' check (status in ('scheduled','done','cancelled','error')),
  last_run_at  timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists jb_posts_due_idx on jb_posts (status, run_at);

create table if not exists jb_published (
  id          bigint generated always as identity primary key,
  bot_id      bigint not null,
  post_id     bigint not null references jb_posts(id) on delete cascade,
  run_key     text not null,                   -- run time of this publication; makes retries idempotent
  channel_id  bigint not null,
  message_id  bigint,
  status      text not null default 'ok' check (status in ('ok','failed')),
  error       text,
  created_at  timestamptz not null default now(),
  unique (post_id, run_key, channel_id)
);

create table if not exists jb_broadcasts (
  id           bigint generated always as identity primary key,
  bot_id       bigint not null references jb_bots(id) on delete cascade,
  text         text,
  media_type   text not null default 'none' check (media_type in ('none','photo','video')),
  media_url    text,
  button_text  text,
  button_url   text,
  audience     text not null default 'all' check (audience in ('all','verified','active','task_doers')),
  run_at       timestamptz not null default now(),
  status       text not null default 'queued' check (status in ('queued','running','done','cancelled')),
  total        int not null default 0,
  sent         int not null default 0,
  failed       int not null default 0,
  cursor_id    bigint not null default 0,
  created_at   timestamptz not null default now(),
  finished_at  timestamptz
);
create index if not exists jb_bc_idx on jb_broadcasts (bot_id, status, run_at);

create table if not exists jb_announcements (
  id         bigint generated always as identity primary key,
  bot_id     bigint not null references jb_bots(id) on delete cascade,
  title      text not null,
  body       text,
  pinned     boolean not null default false,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists jb_flags (
  id         bigint generated always as identity primary key,
  bot_id     bigint not null references jb_bots(id) on delete cascade,
  user_id    bigint not null,
  kind       text not null,
  detail     text,
  status     text not null default 'open' check (status in ('open','dismissed','actioned')),
  created_at timestamptz not null default now()
);
create index if not exists jb_flags_idx on jb_flags (bot_id, status, created_at desc);

create table if not exists jb_audit (
  id         bigint generated always as identity primary key,
  bot_id     bigint,
  actor      text not null,          -- telegram id of a bot admin, or 'platform' for the controller
  role       text,
  action     text not null,
  target     text,
  detail     jsonb,
  created_at timestamptz not null default now()
);
create index if not exists jb_audit_idx on jb_audit (bot_id, created_at desc);

create table if not exists jb_tickets (
  id         bigint generated always as identity primary key,
  bot_id     bigint not null references jb_bots(id) on delete cascade,
  user_id    bigint not null,
  subject    text not null,
  status     text not null default 'open' check (status in ('open','closed')),
  created_at timestamptz not null default now()
);
create table if not exists jb_ticket_msgs (
  id         bigint generated always as identity primary key,
  ticket_id  bigint not null references jb_tickets(id) on delete cascade,
  from_admin boolean not null default false,
  body       text not null,
  created_at timestamptz not null default now()
);

create table if not exists jb_campaigns (
  id             bigint generated always as identity primary key,
  bot_id         bigint not null references jb_bots(id) on delete cascade,
  name           text not null,
  starts_at      timestamptz not null,
  ends_at        timestamptz not null,
  task_bonus_pct numeric(6,2) not null default 0,      -- +% on every task reward during the campaign
  referral_bonus numeric(14,2) not null default 0,     -- extra birr per qualified referral during the campaign
  active         boolean not null default true,
  created_at     timestamptz not null default now()
);

-- ---------------- money functions: every balance change goes through these ----------------

create or replace function jb_credit(p_bot bigint, p_user bigint, p_amount numeric, p_kind text, p_ref text, p_note text)
returns numeric language plpgsql as $$
declare
  v_bal numeric;
  v_amt numeric;
begin
  if p_amount is null or p_amount = 0 then
    return 0;
  end if;
  select balance into v_bal from jb_users where bot_id = p_bot and tg_id = p_user for update;
  if not found then
    return 0;
  end if;
  if p_amount < 0 then
    v_amt := -least(-p_amount, v_bal);
  else
    v_amt := p_amount;
  end if;
  if v_amt = 0 then
    return 0;
  end if;
  begin
    insert into jb_ledger (bot_id, user_id, amount, kind, ref_key, note)
    values (p_bot, p_user, v_amt, p_kind, p_ref, p_note);
  exception when unique_violation then
    return 0;
  end;
  update jb_users
     set balance      = balance + v_amt,
         total_earned = total_earned + case when p_kind in ('task','daily','referral') and v_amt > 0 then v_amt else 0 end,
         earned_task  = earned_task  + case when p_kind in ('task','daily') and v_amt > 0 then v_amt else 0 end,
         earned_ref   = earned_ref   + case when p_kind = 'referral' and v_amt > 0 then v_amt else 0 end
   where bot_id = p_bot and tg_id = p_user;
  return v_amt;
end $$;

create or replace function jb_claim_task(p_bot bigint, p_task bigint, p_user bigint, p_day text, p_proof text, p_reward numeric)
returns jsonb language plpgsql as $$
declare
  t jb_tasks%rowtype;
  v_status text;
  v_today int;
  v_claim bigint;
begin
  select * into t from jb_tasks where id = p_task and bot_id = p_bot for update;
  if not found or t.status <> 'active' then
    raise exception 'task_unavailable';
  end if;
  if t.starts_at is not null and t.starts_at > now() then
    raise exception 'task_unavailable';
  end if;
  if t.expires_at is not null and t.expires_at <= now() then
    raise exception 'task_expired';
  end if;
  if t.type <> 'daily' and t.max_participants is not null and t.participants_count >= t.max_participants then
    raise exception 'task_full';
  end if;
  if t.daily_limit is not null then
    select count(*) into v_today from jb_task_claims
     where task_id = p_task and created_at >= date_trunc('day', now() at time zone 'Africa/Addis_Ababa') at time zone 'Africa/Addis_Ababa'
       and status in ('approved', 'pending');
    if v_today >= t.daily_limit then
      raise exception 'task_daily_full';
    end if;
  end if;
  v_status := case when t.requires_review then 'pending' else 'approved' end;
  begin
    insert into jb_task_claims (bot_id, task_id, user_id, day_key, status, proof, reward)
    values (p_bot, p_task, p_user, p_day, v_status, p_proof, p_reward)
    returning id into v_claim;
  exception when unique_violation then
    raise exception 'duplicate';
  end;
  if v_status = 'approved' then
    update jb_tasks set participants_count = participants_count + 1 where id = p_task;
    perform jb_credit(p_bot, p_user, p_reward, case when t.type = 'daily' then 'daily' else 'task' end, 'c' || v_claim::text, t.title);
  end if;
  return jsonb_build_object('claim_id', v_claim, 'status', v_status, 'reward', p_reward);
end $$;

create or replace function jb_review_claim(p_bot bigint, p_claim bigint, p_approve boolean, p_by bigint)
returns jsonb language plpgsql as $$
declare
  c jb_task_claims%rowtype;
  v_title text;
begin
  select * into c from jb_task_claims where id = p_claim and bot_id = p_bot for update;
  if not found or c.status <> 'pending' then
    raise exception 'not_pending';
  end if;
  select title into v_title from jb_tasks where id = c.task_id;
  if p_approve then
    update jb_task_claims set status = 'approved', decided_at = now(), decided_by = p_by where id = c.id;
    update jb_tasks set participants_count = participants_count + 1 where id = c.task_id;
    perform jb_credit(p_bot, c.user_id, c.reward, 'task', 'c' || c.id::text, v_title);
  else
    update jb_task_claims set status = 'rejected', decided_at = now(), decided_by = p_by where id = c.id;
  end if;
  return jsonb_build_object('user_id', c.user_id, 'reward', c.reward, 'title', v_title,
                            'status', case when p_approve then 'approved' else 'rejected' end);
end $$;

create or replace function jb_reverse_claim(p_bot bigint, p_claim bigint, p_note text)
returns numeric language plpgsql as $$
declare
  c jb_task_claims%rowtype;
  v_amt numeric;
begin
  select * into c from jb_task_claims where id = p_claim and bot_id = p_bot for update;
  if not found or c.status <> 'approved' then
    return 0;
  end if;
  update jb_task_claims set status = 'reversed', decided_at = now() where id = c.id;
  v_amt := jb_credit(p_bot, c.user_id, -c.reward, 'reversal', 'rv' || c.id::text, p_note);
  return -v_amt;
end $$;

create or replace function jb_request_withdraw(p_bot bigint, p_user bigint, p_amount numeric, p_fee numeric,
                                               p_method text, p_account text, p_min numeric, p_max numeric)
returns bigint language plpgsql as $$
declare
  v_bal numeric;
  v_banned boolean;
  v_review boolean;
  v_id bigint;
begin
  select balance, banned, review into v_bal, v_banned, v_review from jb_users where bot_id = p_bot and tg_id = p_user for update;
  if not found or v_banned then
    raise exception 'no_user';
  end if;
  if v_review then
    raise exception 'under_review';
  end if;
  if exists (select 1 from jb_withdrawals where bot_id = p_bot and user_id = p_user and status in ('pending','approved','processing')) then
    raise exception 'pending_exists';
  end if;
  if p_amount < p_min then
    raise exception 'below_min';
  end if;
  if p_max > 0 and p_amount > p_max then
    raise exception 'above_max';
  end if;
  if p_fee >= p_amount then
    raise exception 'fee_too_high';
  end if;
  if p_amount > v_bal then
    raise exception 'low_balance';
  end if;
  insert into jb_withdrawals (bot_id, user_id, amount, fee, net, method, account)
  values (p_bot, p_user, p_amount, p_fee, p_amount - p_fee, p_method, p_account)
  returning id into v_id;
  update jb_users set balance = balance - p_amount, pending = pending + p_amount where bot_id = p_bot and tg_id = p_user;
  insert into jb_ledger (bot_id, user_id, amount, kind, ref_key, note)
  values (p_bot, p_user, -p_amount, 'withdraw', 'w' || v_id::text, p_method);
  return v_id;
end $$;

create or replace function jb_set_withdraw_status(p_bot bigint, p_id bigint, p_status text, p_by bigint, p_note text, p_ref text)
returns jsonb language plpgsql as $$
declare
  r jb_withdrawals%rowtype;
  ok boolean;
begin
  select * into r from jb_withdrawals where id = p_id and bot_id = p_bot for update;
  if not found then
    raise exception 'not_found';
  end if;
  ok := (r.status = 'pending'    and p_status in ('approved', 'rejected'))
     or (r.status = 'approved'   and p_status in ('processing', 'paid', 'rejected'))
     or (r.status = 'processing' and p_status in ('paid', 'rejected'));
  if not ok then
    raise exception 'bad_transition';
  end if;
  update jb_withdrawals
     set status = p_status, note = coalesce(p_note, note), pay_ref = coalesce(p_ref, pay_ref),
         resolved_by = p_by, resolved_at = case when p_status in ('paid', 'rejected') then now() else resolved_at end
   where id = p_id;
  if p_status = 'rejected' then
    update jb_users set balance = balance + r.amount, pending = pending - r.amount where bot_id = p_bot and tg_id = r.user_id;
    insert into jb_ledger (bot_id, user_id, amount, kind, ref_key, note)
    values (p_bot, r.user_id, r.amount, 'refund', 'wr' || p_id::text, 'withdrawal rejected');
  elsif p_status = 'paid' then
    update jb_users set pending = pending - r.amount, withdrawn_total = withdrawn_total + r.net where bot_id = p_bot and tg_id = r.user_id;
  end if;
  return jsonb_build_object('user_id', r.user_id, 'amount', r.amount, 'net', r.net, 'status', p_status);
end $$;

create or replace function jb_stats(p_bot bigint)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'total_users',     (select count(*) from jb_users where bot_id = p_bot),
    'verified_users',  (select count(*) from jb_users where bot_id = p_bot and captcha_ok),
    'active_users',    (select count(*) from jb_users where bot_id = p_bot and last_seen >= now() - interval '7 days'),
    'blocked',         (select count(*) from jb_users where bot_id = p_bot and blocked),
    'new_today',       (select count(*) from jb_users where bot_id = p_bot
                         and (joined_at at time zone 'Africa/Addis_Ababa')::date = (now() at time zone 'Africa/Addis_Ababa')::date),
    'completions',     (select count(*) from jb_task_claims where bot_id = p_bot and status = 'approved'),
    'ref_earnings',    (select coalesce(sum(earned_ref), 0) from jb_users where bot_id = p_bot),
    'rewards_total',   (select coalesce(sum(total_earned), 0) from jb_users where bot_id = p_bot),
    'liabilities',     (select coalesce(sum(balance + pending), 0) from jb_users where bot_id = p_bot),
    'paid_total',      (select coalesce(sum(net), 0) from jb_withdrawals where bot_id = p_bot and status = 'paid'),
    'pending_count',   (select count(*) from jb_withdrawals where bot_id = p_bot and status in ('pending','approved','processing')),
    'pending_sum',     (select coalesce(sum(amount), 0) from jb_withdrawals where bot_id = p_bot and status in ('pending','approved','processing')),
    'review_claims',   (select count(*) from jb_task_claims where bot_id = p_bot and status = 'pending'),
    'open_flags',      (select count(*) from jb_flags where bot_id = p_bot and status = 'open'),
    'daily',           (select coalesce(jsonb_agg(jsonb_build_object('day', s.d, 'users', s.n, 'claims', s.c) order by s.d), '[]'::jsonb)
                          from (select g.d,
                                       (select count(*) from jb_users u where u.bot_id = p_bot and (u.joined_at at time zone 'Africa/Addis_Ababa')::date = g.d) as n,
                                       (select count(*) from jb_task_claims k where k.bot_id = p_bot and k.status = 'approved' and (k.created_at at time zone 'Africa/Addis_Ababa')::date = g.d) as c
                                  from (select generate_series(((now() at time zone 'Africa/Addis_Ababa')::date - 13), (now() at time zone 'Africa/Addis_Ababa')::date, interval '1 day')::date as d) g) s)
  );
$$;

create or replace function jb_leaderboard(p_bot bigint, p_by text, p_limit int)
returns table (user_id bigint, label text, score numeric) language sql stable as $$
  select u.tg_id, coalesce(u.first_name, u.username, u.tg_id::text),
         case p_by
           when 'referrals' then (select count(*) from jb_referrals r where r.bot_id = u.bot_id and r.referrer_id = u.tg_id and r.status = 'qualified')::numeric
           when 'tasks'     then (select count(*) from jb_task_claims c where c.bot_id = u.bot_id and c.user_id = u.tg_id and c.status = 'approved')::numeric
           else u.total_earned
         end as score
    from jb_users u
   where u.bot_id = p_bot and not u.banned
   order by score desc, u.tg_id
   limit p_limit;
$$;

-- only the backend (service role key) may use these tables and functions
alter table jb_bots enable row level security;
alter table jb_admins enable row level security;
alter table jb_users enable row level security;
alter table jb_referrals enable row level security;
alter table jb_channels enable row level security;
alter table jb_tasks enable row level security;
alter table jb_task_claims enable row level security;
alter table jb_ledger enable row level security;
alter table jb_withdrawals enable row level security;
alter table jb_posts enable row level security;
alter table jb_published enable row level security;
alter table jb_broadcasts enable row level security;
alter table jb_announcements enable row level security;
alter table jb_flags enable row level security;
alter table jb_audit enable row level security;
alter table jb_tickets enable row level security;
alter table jb_ticket_msgs enable row level security;
alter table jb_campaigns enable row level security;

do $$ begin
  revoke all on function jb_credit(bigint, bigint, numeric, text, text, text) from public, anon, authenticated;
  revoke all on function jb_claim_task(bigint, bigint, bigint, text, text, numeric) from public, anon, authenticated;
  revoke all on function jb_review_claim(bigint, bigint, boolean, bigint) from public, anon, authenticated;
  revoke all on function jb_reverse_claim(bigint, bigint, text) from public, anon, authenticated;
  revoke all on function jb_request_withdraw(bigint, bigint, numeric, numeric, text, text, numeric, numeric) from public, anon, authenticated;
  revoke all on function jb_set_withdraw_status(bigint, bigint, text, bigint, text, text) from public, anon, authenticated;
  revoke all on function jb_stats(bigint) from public, anon, authenticated;
  revoke all on function jb_leaderboard(bigint, text, int) from public, anon, authenticated;
exception when others then null;
end $$;
