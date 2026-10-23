// Test harness: a tiny express-like shim, an in-memory database that mimics the SQL functions, and a fake Telegram.
const http = require('http');
const crypto = require('crypto');

/* ---------------- express-like shim ---------------- */
function makeApp() {
  const routes = [];
  const add = (m) => (p, ...h) => routes.push({ m, p, h });
  const app = { get: add('GET'), post: add('POST'), put: add('PUT'), delete: add('DELETE'), set() {}, use() {} };
  const match = (r, method, path) => {
    if (r.m !== method) return null; const a = r.p.split('/'), b = path.split('/'); if (a.length !== b.length) return null;
    const params = {}; for (let i = 0; i < a.length; i++) { if (a[i].startsWith(':')) params[a[i].slice(1)] = decodeURIComponent(b[i]); else if (a[i] !== b[i]) return null; } return params;
  };
  app.call = async (method, url, { headers = {}, body } = {}) => {
    const [path, qs] = url.split('?'); const query = Object.fromEntries(new URLSearchParams(qs || ''));
    const out = { code: 200, headers: {}, body: undefined, text: undefined };
    const res = { set(k, v) { if (typeof k === 'object') Object.assign(out.headers, k); else out.headers[k] = v; return res; }, status(c) { out.code = c; return res; }, json(o) { out.body = o; res.headersSent = true; return res; }, send(t) { out.text = t; res.headersSent = true; return res; }, type() { return res; }, headersSent: false };
    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    for (const r of routes) {
      const params = match(r, method, path); if (!params) continue;
      const req = { params, query, body, get: (k) => lower[k.toLowerCase()] };
      await r.h[0](req, res); return out;
    }
    out.code = 404; return out;
  };
  return app;
}

/* ---------------- in-memory database ---------------- */
const now = () => new Date().toISOString();
const DEF = {
  jb_bots: () => ({ status: 'active', settings: {}, created_at: now() }),
  jb_admins: () => ({ role: 'admin', added_at: now() }),
  jb_users: () => ({ lang: null, captcha: null, captcha_ok: false, captcha_fails: 0, cooldown_until: null, phone: null, banned: false, blocked: false, review: false, notify: true, balance: 0, pending: 0, total_earned: 0, earned_task: 0, earned_ref: 0, withdrawn_total: 0, state: null, joined_at: now(), last_seen: now() }),
  jb_referrals: () => ({ status: 'pending', reward: 0, created_at: now(), qualified_at: null }),
  jb_channels: () => ({ username: null, invite_link: null, kind: 'channel', last_error: null, created_at: now() }),
  jb_tasks: () => ({ description: null, channel_id: null, chat_id: null, username: null, url: null, reward: 0, max_participants: null, daily_limit: null, min_seconds: 10, requires_review: false, starts_at: null, expires_at: null, status: 'active', sort: 0, participants_count: 0, created_at: now() }),
  jb_task_claims: () => ({ day_key: '', status: 'approved', proof: null, reward: 0, created_at: now(), decided_at: null, decided_by: null, checked_at: null }),
  jb_ledger: () => ({ ref_key: null, note: null, created_at: now() }),
  jb_withdrawals: () => ({ fee: 0, status: 'pending', note: null, pay_ref: null, created_at: now(), resolved_at: null, resolved_by: null }),
  jb_posts: () => ({ text: null, media_type: 'none', media_url: null, button_text: null, button_url: null, targets: [], repeat: 'none', status: 'scheduled', last_run_at: null, created_at: now() }),
  jb_published: () => ({ message_id: null, status: 'ok', error: null, created_at: now() }),
  jb_broadcasts: () => ({ text: null, media_type: 'none', media_url: null, button_text: null, button_url: null, audience: 'all', run_at: now(), status: 'queued', total: 0, sent: 0, failed: 0, cursor_id: 0, created_at: now(), finished_at: null }),
  jb_announcements: () => ({ body: null, pinned: false, active: true, created_at: now() }),
  jb_flags: () => ({ detail: null, status: 'open', created_at: now() }),
  jb_audit: () => ({ created_at: now() }),
  jb_tickets: () => ({ status: 'open', created_at: now() }),
  jb_ticket_msgs: () => ({ from_admin: false, created_at: now() }),
  jb_campaigns: () => ({ task_bonus_pct: 0, referral_bonus: 0, active: true, created_at: now() }),
};
const IDENT = new Set(['jb_bots', 'jb_channels', 'jb_tasks', 'jb_task_claims', 'jb_ledger', 'jb_withdrawals', 'jb_posts', 'jb_published', 'jb_broadcasts', 'jb_announcements', 'jb_flags', 'jb_audit', 'jb_tickets', 'jb_ticket_msgs', 'jb_campaigns']);
const UNIQ = { jb_bots: [['tg_id']], jb_admins: [['bot_id', 'tg_id']], jb_users: [['bot_id', 'tg_id']], jb_referrals: [['bot_id', 'referred_id']], jb_channels: [['bot_id', 'chat_id']], jb_task_claims: [['task_id', 'user_id', 'day_key']], jb_published: [['post_id', 'run_key', 'channel_id']] };
const cmp = (a, b) => (a > b ? 1 : a < b ? -1 : 0);

function makeDb() {
  const T = Object.fromEntries(Object.keys(DEF).map((k) => [k, []])); const seq = {};
  const nextId = (t) => (seq[t] = (seq[t] || 0) + 1);
  const dupe = (t, row) => {
    for (const cols of UNIQ[t] || []) if (T[t].some((r) => cols.every((c) => r[c] === row[c]))) return true;
    if (t === 'jb_users' && row.phone != null && T[t].some((r) => r.bot_id === row.bot_id && r.phone === row.phone)) return true;
    return false;
  };
  function from(t) {
    const st = { f: [], ord: [], lim: null, rng: null, op: 'select', payload: null, single: false, head: false, count: false, ret: false };
    const b = {
      select(_c, o) { if (st.op === 'select') { if (o && o.head) st.head = true; if (o && o.count) st.count = true; } else st.ret = true; return b; },
      eq(c, v) { st.f.push((r) => r[c] === v); return b; }, neq(c, v) { st.f.push((r) => r[c] !== v); return b; }, in(c, v) { st.f.push((r) => v.includes(r[c])); return b; },
      gt(c, v) { st.f.push((r) => r[c] > v); return b; }, gte(c, v) { st.f.push((r) => r[c] >= v); return b; }, lt(c, v) { st.f.push((r) => r[c] < v); return b; }, lte(c, v) { st.f.push((r) => r[c] <= v); return b; },
      ilike(c, p) { const re = new RegExp(`^${String(p).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*')}$`, 'i'); st.f.push((r) => r[c] != null && re.test(String(r[c]))); return b; },
      order(c, o) { st.ord.push([c, o && o.ascending === false ? -1 : 1]); return b; }, limit(n) { st.lim = n; return b; }, range(a, z) { st.rng = [a, z]; return b; },
      maybeSingle() { st.single = true; return b; }, single() { st.single = 'strict'; return b; },
      insert(p) { st.op = 'insert'; st.payload = p; return b; }, update(p) { st.op = 'update'; st.payload = p; return b; }, delete() { st.op = 'delete'; return b; },
      then(ok, bad) {
        let r; try { r = run(); } catch (e) { return Promise.reject(e).then(ok, bad); } return Promise.resolve(r).then(ok, bad);
      },
    };
    function run() {
      if (st.op === 'insert') {
        const rows = (Array.isArray(st.payload) ? st.payload : [st.payload]).map((p) => ({ ...(DEF[t] ? DEF[t]() : {}), ...p }));
        const out = [];
        for (const row of rows) { if (IDENT.has(t)) row.id = nextId(t); if (dupe(t, row)) return { data: null, error: { message: `duplicate key value violates unique constraint (${t})` } }; T[t].push(row); out.push(row); }
        return st.ret ? { data: st.single ? out[0] : out, error: null } : { data: null, error: null };
      }
      let rows = T[t].filter((r) => st.f.every((f) => f(r)));
      if (st.op === 'update') { rows.forEach((r) => Object.assign(r, st.payload)); return { data: st.ret ? rows : null, error: null }; }
      if (st.op === 'delete') { T[t] = T[t].filter((r) => !rows.includes(r)); return { data: null, error: null }; }
      for (const [c, d] of [...st.ord].reverse()) rows = [...rows].sort((x, y) => cmp(x[c], y[c]) * d);
      if (st.count && st.head) return { count: rows.length, data: null, error: null };
      if (st.rng) rows = rows.slice(st.rng[0], st.rng[1] + 1);
      if (st.lim != null) rows = rows.slice(0, st.lim);
      rows = rows.map((r) => ({ ...r }));
      if (st.single) return { data: rows[0] || null, error: null };
      return { data: rows, count: rows.length, error: null };
    }
    return b;
  }

  /* ---- the SQL functions, mirrored in JS ---- */
  const U = (bot, id) => T.jb_users.find((u) => u.bot_id === bot && u.tg_id === id);
  const fail = (m) => { throw Object.assign(new Error(m), { sql: true }); };
  const R2 = (n) => Math.round(n * 100) / 100;
  function credit(bot, user, amount, kind, ref, note) {
    if (!amount) return 0; const u = U(bot, user); if (!u) return 0;
    const amt = amount < 0 ? -Math.min(-amount, u.balance) : amount; if (!amt) return 0;
    if (ref != null && T.jb_ledger.some((l) => l.bot_id === bot && l.user_id === user && l.kind === kind && l.ref_key === ref)) return 0;
    T.jb_ledger.push({ ...DEF.jb_ledger(), id: nextId('jb_ledger'), bot_id: bot, user_id: user, amount: amt, kind, ref_key: ref, note });
    u.balance = R2(u.balance + amt);
    if (amt > 0 && ['task', 'daily', 'referral'].includes(kind)) u.total_earned = R2(u.total_earned + amt);
    if (amt > 0 && ['task', 'daily'].includes(kind)) u.earned_task = R2(u.earned_task + amt);
    if (amt > 0 && kind === 'referral') u.earned_ref = R2(u.earned_ref + amt);
    return amt;
  }
  const fns = {
    jb_credit: (a) => credit(a.p_bot, a.p_user, Number(a.p_amount), a.p_kind, a.p_ref, a.p_note),
    jb_claim_task: (a) => {
      const t = T.jb_tasks.find((x) => x.id === a.p_task && x.bot_id === a.p_bot);
      if (!t || t.status !== 'active') fail('task_unavailable');
      if (t.starts_at && t.starts_at > now()) fail('task_unavailable');
      if (t.expires_at && t.expires_at <= now()) fail('task_expired');
      if (t.type !== 'daily' && t.max_participants != null && t.participants_count >= t.max_participants) fail('task_full');
      if (t.daily_limit != null) { const day = new Date().toISOString().slice(0, 10); if (T.jb_task_claims.filter((c) => c.task_id === t.id && c.created_at.slice(0, 10) === day && ['approved', 'pending'].includes(c.status)).length >= t.daily_limit) fail('task_daily_full'); }
      const status = t.requires_review ? 'pending' : 'approved';
      const row = { ...DEF.jb_task_claims(), bot_id: a.p_bot, task_id: a.p_task, user_id: a.p_user, day_key: a.p_day, status, proof: a.p_proof, reward: Number(a.p_reward) };
      if (dupe('jb_task_claims', row)) fail('duplicate');
      row.id = nextId('jb_task_claims'); T.jb_task_claims.push(row);
      if (status === 'approved') { t.participants_count++; credit(a.p_bot, a.p_user, Number(a.p_reward), t.type === 'daily' ? 'daily' : 'task', `c${row.id}`, t.title); }
      return { claim_id: row.id, status, reward: Number(a.p_reward) };
    },
    jb_review_claim: (a) => {
      const c = T.jb_task_claims.find((x) => x.id === a.p_claim && x.bot_id === a.p_bot); if (!c || c.status !== 'pending') fail('not_pending');
      const t = T.jb_tasks.find((x) => x.id === c.task_id);
      if (a.p_approve) { c.status = 'approved'; t.participants_count++; credit(a.p_bot, c.user_id, c.reward, 'task', `c${c.id}`, t.title); } else c.status = 'rejected';
      return { user_id: c.user_id, reward: c.reward, title: t.title, status: a.p_approve ? 'approved' : 'rejected' };
    },
    jb_reverse_claim: (a) => {
      const c = T.jb_task_claims.find((x) => x.id === a.p_claim && x.bot_id === a.p_bot); if (!c || c.status !== 'approved') return 0;
      c.status = 'reversed'; return -credit(a.p_bot, c.user_id, -c.reward, 'reversal', `rv${c.id}`, a.p_note);
    },
    jb_request_withdraw: (a) => {
      const u = U(a.p_bot, a.p_user); if (!u || u.banned) fail('no_user'); if (u.review) fail('under_review');
      if (T.jb_withdrawals.some((w) => w.bot_id === a.p_bot && w.user_id === a.p_user && ['pending', 'approved', 'processing'].includes(w.status))) fail('pending_exists');
      if (a.p_amount < a.p_min) fail('below_min'); if (a.p_max > 0 && a.p_amount > a.p_max) fail('above_max'); if (a.p_fee >= a.p_amount) fail('fee_too_high'); if (a.p_amount > u.balance) fail('low_balance');
      const id = nextId('jb_withdrawals'); T.jb_withdrawals.push({ ...DEF.jb_withdrawals(), id, bot_id: a.p_bot, user_id: a.p_user, amount: a.p_amount, fee: a.p_fee, net: R2(a.p_amount - a.p_fee), method: a.p_method, account: a.p_account });
      u.balance = R2(u.balance - a.p_amount); u.pending = R2(u.pending + a.p_amount);
      T.jb_ledger.push({ ...DEF.jb_ledger(), id: nextId('jb_ledger'), bot_id: a.p_bot, user_id: a.p_user, amount: -a.p_amount, kind: 'withdraw', ref_key: `w${id}`, note: a.p_method });
      return id;
    },
    jb_set_withdraw_status: (a) => {
      const w = T.jb_withdrawals.find((x) => x.id === a.p_id && x.bot_id === a.p_bot); if (!w) fail('not_found');
      const ok = (w.status === 'pending' && ['approved', 'rejected'].includes(a.p_status)) || (w.status === 'approved' && ['processing', 'paid', 'rejected'].includes(a.p_status)) || (w.status === 'processing' && ['paid', 'rejected'].includes(a.p_status));
      if (!ok) fail('bad_transition');
      Object.assign(w, { status: a.p_status, note: a.p_note || w.note, pay_ref: a.p_ref || w.pay_ref, resolved_by: a.p_by }); const u = U(a.p_bot, w.user_id);
      if (a.p_status === 'rejected') { u.balance = R2(u.balance + w.amount); u.pending = R2(u.pending - w.amount); T.jb_ledger.push({ ...DEF.jb_ledger(), id: nextId('jb_ledger'), bot_id: a.p_bot, user_id: w.user_id, amount: w.amount, kind: 'refund', ref_key: `wr${w.id}`, note: 'withdrawal rejected' }); }
      if (a.p_status === 'paid') { u.pending = R2(u.pending - w.amount); u.withdrawn_total = R2(u.withdrawn_total + w.net); }
      return { user_id: w.user_id, amount: w.amount, net: w.net, status: a.p_status };
    },
    jb_stats: (a) => { const us = T.jb_users.filter((u) => u.bot_id === a.p_bot); const wd = T.jb_withdrawals.filter((w) => w.bot_id === a.p_bot); return { total_users: us.length, verified_users: us.filter((u) => u.captcha_ok).length, active_users: us.length, blocked: us.filter((u) => u.blocked).length, new_today: us.length, completions: T.jb_task_claims.filter((c) => c.bot_id === a.p_bot && c.status === 'approved').length, ref_earnings: us.reduce((s, u) => s + u.earned_ref, 0), rewards_total: us.reduce((s, u) => s + u.total_earned, 0), liabilities: us.reduce((s, u) => s + u.balance + u.pending, 0), paid_total: wd.filter((w) => w.status === 'paid').reduce((s, w) => s + w.net, 0), pending_count: wd.filter((w) => ['pending', 'approved', 'processing'].includes(w.status)).length, pending_sum: 0, review_claims: T.jb_task_claims.filter((c) => c.bot_id === a.p_bot && c.status === 'pending').length, open_flags: T.jb_flags.filter((f) => f.bot_id === a.p_bot && f.status === 'open').length, daily: [] }; },
    jb_leaderboard: (a) => T.jb_users.filter((u) => u.bot_id === a.p_bot && !u.banned).map((u) => ({ user_id: u.tg_id, label: u.first_name || String(u.tg_id), score: a.p_by === 'tasks' ? T.jb_task_claims.filter((c) => c.user_id === u.tg_id && c.status === 'approved').length : a.p_by === 'referrals' ? T.jb_referrals.filter((r) => r.referrer_id === u.tg_id && r.status === 'qualified').length : u.total_earned })).sort((x, y) => y.score - x.score).slice(0, a.p_limit),
  };
  const rpc = async (fn, args) => { try { return { data: fns[fn](args), error: null }; } catch (e) { if (e.sql) return { data: null, error: { message: e.message } }; throw e; } };
  return { from, rpc, T };
}

/* ---------------- fake Telegram ---------------- */
async function makeTelegram() {
  const st = { calls: [], members: {}, chats: {}, failSend: new Set(), failMember: new Set(), bots: {}, mid: 100 };
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => (body += c)); req.on('end', () => {
      const m = /^\/bot([^/]+)\/(\w+)$/.exec(req.url); const params = body ? JSON.parse(body) : {}; const token = m && m[1]; const method = m && m[2];
      st.calls.push({ token, method, params });
      const ok = (result) => res.end(JSON.stringify({ ok: true, result })); const err = (code, d) => res.end(JSON.stringify({ ok: false, error_code: code, description: d }));
      switch (method) {
        case 'getMe': { const b = st.bots[token]; return b ? ok({ id: b.id, is_bot: true, username: b.username, first_name: b.name || b.username }) : err(401, 'Unauthorized'); }
        case 'getChat': { const c = st.chats[params.chat_id]; return c ? ok(c) : err(400, 'Bad Request: chat not found'); }
        case 'getChatMember': {
          const bot = st.bots[token]; const chat = Object.values(st.chats).find((c) => c.id === params.chat_id);
          if (bot && params.user_id === bot.id) return chat && chat.botAdmin !== false ? ok({ status: 'administrator' }) : ok({ status: 'left' });
          if (st.failMember.has(params.chat_id)) return err(400, 'Bad Request: not enough rights');
          return ok({ status: st.members[`${params.chat_id}:${params.user_id}`] || 'left' });
        }
        case 'sendMessage': case 'sendPhoto': case 'sendVideo':
          if (st.failSend.has(params.chat_id)) return err(params.chat_id > 0 ? 403 : 400, params.chat_id > 0 ? 'Forbidden: bot was blocked by the user' : 'Bad Request: chat not found');
          return ok({ message_id: st.mid++ });
        default: return ok(true);
      }
    });
  });
  await new Promise((r) => server.listen(0, r));
  process.env.TG_API_BASE = `http://127.0.0.1:${server.address().port}`;
  return { st, close: () => server.close(), sent: (chat, method = 'sendMessage') => st.calls.filter((c) => c.method === method && c.params.chat_id === chat), last: (chat) => [...st.calls].reverse().find((c) => /^send|^edit/.test(c.method) && c.params.chat_id === chat) };
}

function initData(token, user, ageSec = 0) {
  const p = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000) - ageSec), query_id: 'AAH', user: JSON.stringify(user) });
  const str = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  p.set('hash', crypto.createHmac('sha256', crypto.createHmac('sha256', 'WebAppData').update(token).digest()).update(str).digest('hex'));
  return p.toString();
}
module.exports = { makeApp, makeDb, makeTelegram, initData };
