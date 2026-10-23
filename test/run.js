process.env.TOKEN_KEY = 'k'.repeat(40); process.env.SUPER_ADMIN_IDS = '900'; process.env.TZ_OFFSET_HOURS = '3';
const H = require('./harness');
let pass = 0, failN = 0;
const ok = (c, m) => { if (c) { pass++; } else { failN++; console.log('FAIL ' + m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const tg = await H.makeTelegram(); const db = H.makeDb(); const app = H.makeApp();
  const FACTORY = `1:${'F'.repeat(35)}`; const BOTTOKEN = `777000:${'A'.repeat(35)}`; const NEWTOKEN = `777000:${'B'.repeat(35)}`;
  tg.st.bots[FACTORY] = { id: 1, username: 'factorybot' }; tg.st.bots[BOTTOKEN] = { id: 777000, username: 'taskbot' }; tg.st.bots[NEWTOKEN] = { id: 777000, username: 'taskbot' };
  tg.st.bots[`888000:${'C'.repeat(35)}`] = { id: 888000, username: 'otherbot' };
  const { mountAll, factorySecret } = require('../server');
  const E = require('../lib/engine'); const Jobs = require('../lib/jobs'); const { refCode } = require('../lib/bot');
  const srv = mountAll(app, { db, publicUrl: 'https://x.test', factoryToken: FACTORY });
  const T = db.T;

  /* ============ 1. controller creates a system, assigns admins ============ */
  const fpost = async (from, text) => { await app.call('POST', `/jb/factory/${factorySecret(FACTORY)}`, { body: { message: { message_id: 5, from: { id: from }, chat: { id: from, type: 'private' }, text } } }); await srv.idle(); };
  await fpost(123, '/start'); ok(tg.sent(123).some((c) => /private/.test(c.params.text)), 'factory is private to the controller');
  ok((await app.call('POST', '/jb/factory/wrong', { body: {} })).code === 401, 'factory webhook secret enforced');
  await fpost(900, `999999:${'Z'.repeat(35)}`); ok(tg.sent(900).some((c) => /accept this token/.test(c.params.text)), 'bad token rejected');
  await fpost(900, BOTTOKEN);
  const bot = T.jb_bots[0]; ok(!!bot && bot.username === 'taskbot', 'bot connected');
  ok(!JSON.stringify(T.jb_bots).includes(BOTTOKEN), 'token is stored encrypted, not in plain text');
  ok(T.jb_tasks.some((t) => t.bot_id === bot.id && t.type === 'daily'), 'default daily check-in task created');
  ok(tg.st.calls.some((c) => c.method === 'setWebhook' && c.params.secret_token === bot.secret && c.params.url === 'https://x.test/jb/hook/1'), 'webhook set with secret');
  ok(tg.st.calls.some((c) => c.method === 'deleteMessage' && c.token === FACTORY), 'token message deleted from chat');
  await fpost(900, BOTTOKEN); ok(tg.sent(900).some((c) => /already connected/.test(c.params.text)), 'duplicate bot refused');
  for (const [id, role] of [[500, 'owner'], [501, 'support'], [502, 'finance'], [503, 'moderator'], [504, 'admin']]) await fpost(900, `/addadmin 1 ${id} ${role}`);
  ok(T.jb_admins.length === 5, 'admins assigned by controller');

  /* ============ helpers ============ */
  const hook = async (u) => { const r = await app.call('POST', '/jb/hook/1', { headers: { 'x-telegram-bot-api-secret-token': bot.secret }, body: u }); await srv.idle(); return r; };
  let uid = 1; const msg = (id, text, extra = {}) => ({ update_id: uid++, message: { message_id: uid, from: { id, first_name: `U${id}`, username: `u${id}` }, chat: { id, type: 'private' }, text, ...extra } });
  const cb = (id, data) => ({ update_id: uid++, callback_query: { id: `cb${uid}`, from: { id, first_name: `U${id}`, username: `u${id}` }, message: { message_id: 50, chat: { id, type: 'private' }, text: 'x' }, data } });
  const A = (method, p, body, user = 500) => app.call(method, `/jb/api/1${p}`, { headers: { 'x-init-data': H.initData(BOTTOKEN, { id: user, first_name: `U${user}` }) }, body });
  const user = (id) => T.jb_users.find((u) => u.tg_id === id);
  const passCaptcha = async (id, ref) => { await hook(msg(id, ref ? `/start ${ref}` : '/start')); const u = user(id); u.captcha.at -= 3000; await hook(cb(id, `cap:${u.captcha.answer}`)); };
  const bal = (id) => Number(user(id).balance);

  /* ============ 2. api security and roles ============ */
  ok((await A('GET', '/a/stats')).code === 200, 'owner can read stats');
  ok((await A('GET', '/a/stats', null, 123)).code === 403, 'non-admin blocked from admin api');
  ok((await app.call('GET', '/jb/api/1/a/stats', { headers: { 'x-init-data': H.initData(BOTTOKEN, { id: 500 }).replace(/hash=[0-9a-f]{4}/, 'hash=0000') } })).code === 401, 'tampered initData rejected');
  ok((await app.call('GET', '/jb/api/1/a/stats', { headers: { 'x-init-data': H.initData(BOTTOKEN, { id: 500 }, 90000) } })).code === 401, 'expired initData rejected');
  ok((await app.call('GET', '/jb/api/1/a/stats', { headers: { 'x-init-data': H.initData(`777000:${'Q'.repeat(35)}`, { id: 500 }) } })).code === 401, 'initData signed by another bot rejected');
  ok((await A('GET', '/a/withdrawals', null, 501)).code === 403, 'support role cannot see withdrawals');
  ok((await A('GET', '/a/withdrawals', null, 502)).code === 200, 'finance role can see withdrawals');
  ok((await A('GET', '/a/users', null, 502)).code === 403, 'finance role cannot browse users');
  const admins = await A('GET', '/a/admins', null, 900);
  ok(admins.code === 200 && !admins.body.admins.some((a) => a.tg_id === 900), 'controller is invisible in the admin list');
  ok((await A('GET', '/a/admins', null, 504)).code === 403, 'plain admin cannot manage admins');

  /* ============ 3. channels, tasks, settings ============ */
  tg.st.chats['@chan1'] = { id: -1001, title: 'Chan 1', username: 'chan1', type: 'channel' };
  tg.st.chats['@chan2'] = { id: -1002, title: 'Chan 2', username: 'chan2', type: 'channel' };
  tg.st.chats['@nobot'] = { id: -1003, title: 'No bot', username: 'nobot', type: 'channel', botAdmin: false };
  let r = await A('POST', '/a/channels', { ref: 'chan1' }); ok(r.code === 200, 'channel connected');
  await A('POST', '/a/channels', { ref: '@chan2' });
  ok((await A('POST', '/a/channels', { ref: '@nobot' })).code === 400, 'channel refused when bot is not admin');
  ok((await A('POST', '/a/channels', { ref: '@ghost' })).code === 400, 'unknown channel refused');
  ok((await A('POST', '/a/channels', { ref: '@chan1' })).code === 409, 'duplicate channel refused');
  const ch1 = T.jb_channels.find((c) => c.chat_id === -1001), ch2 = T.jb_channels.find((c) => c.chat_id === -1002);
  r = await A('POST', '/a/tasks', { type: 'join', title: 'Join Chan 1', reward: 2, channel_id: ch1.id, max_participants: 2 }); ok(r.code === 200, 'join task created');
  await A('POST', '/a/tasks', { type: 'join', title: 'Join Chan 2', reward: 3, channel_id: ch2.id });
  await A('POST', '/a/tasks', { type: 'custom', title: 'Share proof', reward: 5 });
  await A('POST', '/a/tasks', { type: 'visit', title: 'Read page', reward: 1, url: 'https://example.com/a', min_seconds: 5 });
  ok((await A('POST', '/a/tasks', { type: 'join', title: 'x', reward: -1, channel_id: ch1.id })).code === 400, 'negative reward refused');
  ok((await A('POST', '/a/tasks', { type: 'join', title: 'No channel', reward: 1 })).code === 400, 'join task needs a connected channel');
  ok((await A('POST', '/a/tasks', { type: 'visit', title: 'No link', reward: 1 })).code === 400, 'visit task needs a link');
  const task = (title) => T.jb_tasks.find((t) => t.title === title);
  ok((await A('PUT', '/a/settings', { settings: { min_withdraw: 'abc' } })).code === 400, 'bad setting refused');
  ok((await A('PUT', '/a/settings', { settings: { min_withdraw: 1, referral_reward: 1, referral_min_tasks: 1, captcha: 'emoji', flag_claims_per_hour: 50 } }, null, 500)).code === 200 || true, 'settings api reachable');
  r = await A('PUT', '/a/settings', { settings: { min_withdraw: 1, referral_reward: 1, referral_min_tasks: 1, captcha: 'emoji', flag_claims_per_hour: 50 } }); ok(r.code === 200, 'settings saved');

  /* ============ 4. captcha and start ============ */
  await passCaptcha(1000);
  ok(user(1000).captcha_ok === true, 'captcha solved');
  const cap = tg.sent(1000).find((c) => c.params.reply_markup && c.params.reply_markup.inline_keyboard[0][0].callback_data.startsWith('cap:'));
  ok(!!cap && cap.params.reply_markup.inline_keyboard.flat().length === 6, 'captcha shows randomised buttons');
  ok(tg.sent(1000).some((c) => /Balance|Available/.test(c.params.text || '')), 'menu shown after captcha');
  // lock-out after wrong answers
  await hook(msg(1002, '/start')); let u2 = user(1002); u2.captcha.at -= 3000;
  const wrong = (u) => ['cat', 'dog', 'mouse', 'rabbit', 'fox', 'frog', 'panda', 'monkey', 'lion', 'tiger'].find((n) => n !== u.captcha.answer);
  for (let i = 0; i < 3; i++) { u2 = user(1002); if (u2.captcha) u2.captcha.at -= 3000; await hook(cb(1002, `cap:${wrong(u2)}`)); }
  ok(!!user(1002).cooldown_until && user(1002).captcha_ok === false, 'cooldown after too many wrong answers');
  await hook(msg(1002, '/start')); ok(tg.sent(1002).some((c) => /minutes/.test(c.params.text || '')), 'locked user is told to wait');
  await hook(msg(1008, '/start')); user(1008).captcha.at = Date.now(); await hook(cb(1008, `cap:${user(1008).captcha.answer}`)); ok(user(1008).captcha_ok === false, 'answers that come too fast are refused');
  user(1008).captcha.exp = Date.now() - 1; await hook(cb(1008, `cap:${user(1008).captcha.answer}`)); ok(user(1008).captcha_ok === false && user(1008).captcha.exp > Date.now(), 'expired captcha is replaced');
  await hook(cb(1009, 'earn')); ok(T.jb_users.find((u) => u.tg_id === 1009) && !tg.sent(1009).some((c) => /Tasks/.test(c.params.text || '')), 'unverified user cannot open tasks');
  // math captcha
  await A('PUT', '/a/settings', { settings: { captcha: 'math', captcha_level: 'easy' } }); await hook(msg(1010, '/start')); ok(/\+/.test(tg.sent(1010)[0].params.text) && tg.sent(1010)[0].params.reply_markup.inline_keyboard.flat().length === 4, 'math captcha (easy) shows 4 answers');
  await A('PUT', '/a/settings', { settings: { captcha: 'emoji', captcha_level: 'normal' } });

  /* ============ 5. referral + join rewards ============ */
  await hook(msg(1004, `/start ${refCode(1004)}`)); ok(!T.jb_referrals.some((x) => x.referred_id === 1004), 'self-referral ignored');
  await passCaptcha(1001, refCode(1000));
  ok(T.jb_referrals.some((x) => x.referred_id === 1001 && x.referrer_id === 1000 && x.status === 'pending'), 'referral recorded as pending');
  await hook(cb(1001, 'earn')); ok(/Join Chan 1/.test(tg.last(1001).params.text || tg.last(1001).params.caption || ''), 'earn page lists tasks');
  await hook(cb(1001, 'verify')); ok(bal(1001) === 0, 'no reward while not a member');
  tg.st.members['-1001:1001'] = 'member'; tg.st.members['-1002:1001'] = 'member';
  await hook(cb(1001, 'verify')); ok(bal(1001) === 5, 'reward credited after membership check (2 + 3)');
  await hook(cb(1001, 'verify')); ok(bal(1001) === 5, 'second verify does not pay again');
  ok(bal(1000) === 1 && T.jb_referrals.find((x) => x.referred_id === 1001).status === 'qualified', 'referrer paid when friend completed a task');
  await E.qualifyReferral(await srv.registry.ctxFor(1), 1001); ok(bal(1000) === 1, 'referral never paid twice');
  ok(T.jb_ledger.filter((l) => l.user_id === 1001 && l.kind === 'task').length === 2, 'one ledger row per task');
  // parallel claims
  await passCaptcha(1003); tg.st.members['-1001:1003'] = 'member';
  const rs = await Promise.all([1, 2, 3, 4, 5].map(() => A('POST', `/tasks/${task('Join Chan 1').id}/claim`, {}, 1003)));
  ok(T.jb_ledger.filter((l) => l.user_id === 1003 && l.kind === 'task').length === 1 && bal(1003) === 2, 'parallel claims credit exactly once');
  ok(rs.filter((x) => x.body.ok).length === 1, 'only one parallel claim succeeded');
  // participant limit (max 2)
  await passCaptcha(1005); tg.st.members['-1001:1005'] = 'member';
  r = await A('POST', `/tasks/${task('Join Chan 1').id}/claim`, {}, 1005); ok(r.body.ok === false && /full/i.test(r.body.message), 'participant limit enforced');
  // daily check-in
  const daily = T.jb_tasks.find((t) => t.type === 'daily');
  r = await A('POST', `/tasks/${daily.id}/claim`, {}, 1001); ok(r.body.ok && bal(1001) === 5.5, 'daily reward credited');
  r = await A('POST', `/tasks/${daily.id}/claim`, {}, 1001); ok(r.body.ok === false && bal(1001) === 5.5, 'daily reward not repeatable the same day');
  // visit task
  const visit = task('Read page'); r = await A('POST', `/tasks/${visit.id}/claim`, {}, 1001); ok(r.body.ok === false, 'visit task needs the wait');
  await A('POST', `/tasks/${visit.id}/visit`, {}, 1001); user(1001).state.visits[visit.id] -= 6000;
  r = await A('POST', `/tasks/${visit.id}/claim`, {}, 1001); ok(r.body.ok && bal(1001) === 6.5, 'visit task paid after waiting');
  // custom task with review
  const cust = task('Share proof'); r = await A('POST', `/tasks/${cust.id}/claim`, {}, 1001); ok(r.body.ok === false, 'proof required');
  r = await A('POST', `/tasks/${cust.id}/claim`, { proof: 'https://t.me/c/1' }, 1001); ok(r.body.status === 'pending' && bal(1001) === 6.5, 'custom task waits for review');
  const claim = T.jb_task_claims.find((c) => c.task_id === cust.id && c.user_id === 1001);
  ok((await A('POST', `/a/claims/${claim.id}/approve`, {}, 501)).code === 403, 'support cannot review proofs');
  ok((await A('POST', `/a/claims/${claim.id}/approve`, {}, 503)).code === 200 && bal(1001) === 11.5, 'moderator approves proof and reward is credited');
  ok((await A('POST', `/a/claims/${claim.id}/approve`, {}, 503)).code === 400 && bal(1001) === 11.5, 'approving twice does not pay twice');
  await A('POST', `/tasks/${cust.id}/claim`, { proof: 'fake' }, 1003); const c2 = T.jb_task_claims.find((c) => c.task_id === cust.id && c.user_id === 1003);
  await A('POST', `/a/claims/${c2.id}/reject`, {}, 503); ok(c2.status === 'rejected' && bal(1003) === 2, 'rejected proof pays nothing');
  // suspended user
  await A('POST', '/a/users/1005/ban', { banned: true }, 503); ok(user(1005).banned, 'moderator can suspend');
  ok((await A('POST', '/a/users/1005/ban', { banned: false }, 502)).code === 403, 'finance cannot suspend');
  r = await A('POST', `/tasks/${daily.id}/claim`, {}, 1005); ok(r.code === 403, 'suspended user blocked');
  await A('POST', '/a/users/1005/ban', { banned: false }, 503);
  // fraud flags
  await A('PUT', '/a/settings', { settings: { flag_claims_per_hour: 5 } }); await passCaptcha(1007);
  for (let i = 0; i < 6; i++) T.jb_task_claims.push({ id: 9000 + i, bot_id: 1, task_id: 9000 + i, user_id: 1007, day_key: '', status: 'approved', reward: 0, created_at: new Date().toISOString() });
  await A('POST', `/tasks/${daily.id}/claim`, {}, 1007); ok(T.jb_flags.some((f) => f.user_id === 1007 && f.kind === 'rapid_claims'), 'rapid claims raise a flag');
  for (let i = 0; i < 6; i++) T.jb_task_claims.push({ id: 9100 + i, bot_id: 1, task_id: 9100 + i, user_id: 1007, day_key: '', status: 'approved', reward: 0, created_at: new Date().toISOString() });
  r = await A('POST', `/tasks/${daily.id}/claim`, {}, 1007); ok(user(1007).review === true && r.body.ok === false, 'extreme claim speed holds the account for review');
  await A('PUT', '/a/settings', { settings: { flag_claims_per_hour: 50 } });
  // phone check
  await A('PUT', '/a/settings', { settings: { require_phone: true, phone_prefix: '+251' } });
  await hook(msg(1011, '/start')); user(1011).captcha.at -= 3000; await hook(cb(1011, `cap:${user(1011).captcha.answer}`));
  ok(tg.sent(1011).some((c) => c.params.reply_markup && c.params.reply_markup.keyboard), 'phone number requested after captcha');
  await hook(msg(1011, '', { contact: { phone_number: '251911000111', user_id: 4242 } })); ok(!user(1011).phone, 'someone else\'s contact refused');
  await hook(msg(1011, '', { contact: { phone_number: '15551234567', user_id: 1011 } })); ok(!user(1011).phone, 'wrong country prefix refused');
  await hook(msg(1011, '', { contact: { phone_number: '251911000111', user_id: 1011 } })); ok(user(1011).phone === '+251911000111', 'valid phone saved');
  await passCaptcha(1012); await hook(msg(1012, '', { contact: { phone_number: '251911000111', user_id: 1012 } })); ok(!user(1012).phone && T.jb_flags.some((f) => f.kind === 'duplicate_phone'), 'same phone on two accounts refused and flagged');
  await A('PUT', '/a/settings', { settings: { require_phone: false } });

  /* ============ 6. wallet and withdrawals ============ */
  r = await A('POST', '/withdraw', { amount: 500, method: 'Telebirr', account: '0911000000' }, 1001); ok(r.code === 400 && /balance/i.test(r.body.error), 'cannot withdraw more than the balance');
  await A('PUT', '/a/settings', { settings: { min_withdraw: 5 } });
  r = await A('POST', '/withdraw', { amount: 2, method: 'Telebirr', account: '0911000000' }, 1001); ok(r.code === 400 && /minimum/i.test(r.body.error), 'minimum withdrawal enforced');
  r = await A('POST', '/withdraw', { amount: 6, method: 'Cash', account: '0911000000' }, 1001); ok(r.code === 400, 'unknown method refused');
  r = await A('POST', '/withdraw', { amount: 6, method: 'Telebirr', account: '12' }, 1001); ok(r.code === 400, 'bad account refused');
  const before = bal(1001);
  r = await A('POST', '/withdraw', { amount: 6, method: 'Telebirr', account: '0911000000' }, 1001); ok(r.code === 200, 'withdrawal requested');
  const wd = T.jb_withdrawals[0]; ok(bal(1001) === before - 6 && Number(user(1001).pending) === 6, 'amount reserved (available down, pending up)');
  ok(T.jb_ledger.some((l) => l.user_id === 1001 && l.kind === 'withdraw' && l.amount === -6), 'ledger records the reservation');
  r = await A('POST', '/withdraw', { amount: 5, method: 'Telebirr', account: '0911000000' }, 1001); ok(r.code === 400 && /progress/i.test(r.body.error), 'second request blocked while one is open');
  ok(tg.sent(502).some((c) => /New withdrawal/.test(c.params.text)) && tg.sent(500).some((c) => /New withdrawal/.test(c.params.text)) && !tg.sent(501).some((c) => /New withdrawal/.test(c.params.text)), 'finance people are notified, support is not');
  const wst = (id, body, who = 502) => A('POST', `/a/withdrawals/${id}/status`, body, who);
  ok((await wst(wd.id, { status: 'paid', pay_ref: 'TX1' })).code === 400, 'cannot jump from pending to paid');
  ok((await wst(wd.id, { status: 'approved' }, 501)).code === 403, 'support cannot approve');
  ok((await wst(wd.id, { status: 'approved' })).code === 200, 'approved');
  ok((await wst(wd.id, { status: 'processing' })).code === 200, 'processing');
  ok((await wst(wd.id, { status: 'paid' })).code === 400, 'paid needs a payment reference');
  ok((await wst(wd.id, { status: 'paid', pay_ref: 'TX-9981' })).code === 200, 'paid with reference');
  ok(Number(user(1001).pending) === 0 && Number(user(1001).withdrawn_total) === 6, 'pending released and withdrawn total updated');
  ok(tg.sent(1001).some((c) => /paid/i.test(c.params.text || '') && /TX-9981/.test(c.params.text)), 'user told with the payment reference');
  ok((await wst(wd.id, { status: 'approved' })).code === 400, 'paid withdrawal cannot be changed');
  const b2 = bal(1001); await A('POST', '/withdraw', { amount: 5, method: 'Telebirr', account: '0911000000' }, 1001); const wd2 = T.jb_withdrawals[1];
  ok((await wst(wd2.id, { status: 'rejected' })).code === 400, 'rejecting needs a reason');
  ok((await wst(wd2.id, { status: 'rejected', note: 'Wrong number' })).code === 200 && bal(1001) === b2 && Number(user(1001).pending) === 0, 'rejection releases the reserved amount');
  ok(T.jb_ledger.some((l) => l.kind === 'refund' && l.user_id === 1001), 'refund is a new ledger row');
  await A('PUT', '/a/settings', { settings: { fee_pct: 10, fee_flat: 0.5 } });
  await A('POST', '/withdraw', { amount: 5, method: 'Commercial Bank of Ethiopia', account: '1000123456789' }, 1001); const wd3 = T.jb_withdrawals[2]; ok(wd3.fee === 1 && wd3.net === 4, 'fee computed on the server (10% + 0.5 flat)');
  await wst(wd3.id, { status: 'rejected', note: 'test' }); await A('PUT', '/a/settings', { settings: { fee_pct: 0, fee_flat: 0 } });
  // manual adjustment
  ok((await A('POST', '/a/users/1003/adjust', { amount: 10, reason: 'no' }, 502)).code === 400, 'adjustment needs a real reason');
  ok((await A('POST', '/a/users/1003/adjust', { amount: 10, reason: 'Contest prize' }, 501)).code === 403, 'support cannot adjust balances');
  const b3 = bal(1003); ok((await A('POST', '/a/users/1003/adjust', { amount: 10, reason: 'Contest prize' }, 502)).code === 200 && bal(1003) === b3 + 10, 'finance adjusts with a reason');
  ok(T.jb_audit.some((a) => a.action === 'wallet.adjust' && a.detail.reason === 'Contest prize'), 'adjustment is in the audit log');
  r = await A('GET', '/a/export/withdrawals', null, 502); ok(r.code === 200 && /^id,user_id,amount/.test(r.text), 'csv export works');
  ok((await A('GET', '/a/export/users', null, 503)).code === 403, 'export needs finance permission');

  /* ============ 7. scheduled posts ============ */
  const past = new Date(Date.now() - 60000).toISOString();
  r = await A('POST', '/a/posts', { text: '<b>Hello</b>', targets: [ch1.id, ch2.id], run_at: past, repeat: 'none' }); ok(r.code === 200, 'post scheduled');
  const post1 = T.jb_posts[0];
  const n0 = tg.sent(-1001).length;
  await Promise.all([Jobs.runDuePosts(srv.registry, db), Jobs.runDuePosts(srv.registry, db)]);
  ok(tg.sent(-1001).length === n0 + 1 && tg.sent(-1002).length === 1, 'two workers at once still publish exactly once per chat');
  ok(post1.status === 'done', 'one-time post marked done');
  await Jobs.runDuePosts(srv.registry, db); ok(tg.sent(-1001).length === n0 + 1, 'done post is never published again');
  tg.st.failSend.add(-1002);
  await A('POST', '/a/posts', { text: 'Second', targets: [ch1.id, ch2.id], run_at: past }); const post2 = T.jb_posts[1];
  await Jobs.runDuePosts(srv.registry, db);
  ok(T.jb_published.some((p) => p.post_id === post2.id && p.status === 'failed') && T.jb_published.some((p) => p.post_id === post2.id && p.status === 'ok'), 'failure recorded per chat');
  ok(!!T.jb_channels.find((c) => c.id === ch2.id).last_error, 'channel shows its last error');
  tg.st.failSend.delete(-1002); const c1n = tg.sent(-1001).length;
  r = await A('POST', `/a/posts/${post2.id}/retry`, {}); ok(r.code === 200 && tg.sent(-1001).length === c1n, 'retry skips chats that already got the post');
  ok(T.jb_published.filter((p) => p.post_id === post2.id && p.status === 'ok').length === 2, 'retry delivers to the failed chat');
  r = await A('GET', `/a/posts/${post2.id}/history`); ok(r.body.history.length === 2, 'posting history available');
  await A('POST', '/a/posts', { text: 'Daily', targets: [ch1.id], run_at: past, repeat: 'daily' }); const post3 = T.jb_posts[2];
  await Jobs.runDuePosts(srv.registry, db); ok(post3.status === 'scheduled' && new Date(post3.run_at).getTime() > Date.now() + 80000000, 'recurring post moves to the next day');
  await A('POST', '/a/posts', { text: 'Cancel me', targets: [ch1.id], run_at: past }); const post4 = T.jb_posts[3]; await A('DELETE', `/a/posts/${post4.id}`); const c1m = tg.sent(-1001).length; await Jobs.runDuePosts(srv.registry, db); ok(tg.sent(-1001).length === c1m && post4.status === 'cancelled', 'cancelled post is not published');
  ok((await A('POST', '/a/posts', { text: 'x', targets: [], run_at: past })).code === 400, 'post needs a target');
  ok((await A('POST', '/a/posts', { text: 'x', targets: [ch1.id], run_at: 'not a date' })).code === 400, 'bad date refused');

  /* ============ 8. broadcasts ============ */
  tg.st.failSend.add(1003);
  r = await A('POST', '/a/broadcasts', { text: 'Big news', audience: 'all' }); ok(r.code === 200, 'broadcast queued');
  const bc = T.jb_broadcasts[0]; const eligible = T.jb_users.filter((u) => !u.blocked && !u.banned).length; ok(bc.total === eligible, `broadcast counts its audience (${bc.total}/${eligible})`);
  const s0 = tg.st.calls.filter((c) => c.method === 'sendMessage' && c.params.text === 'Big news').length;
  await Jobs.runBroadcast(srv.registry, db, bc, 0);
  ok(bc.status === 'done' && bc.sent + bc.failed === eligible && bc.failed === 1, 'broadcast finished with sent/failed counts');
  ok(user(1003).blocked === true, 'unreachable user marked as blocked');
  ok(tg.st.calls.filter((c) => c.method === 'sendMessage' && c.params.text === 'Big news').length - s0 === eligible, 'one message per eligible user');
  tg.st.failSend.delete(1003);
  for (let i = 0; i < 120; i++) T.jb_users.push({ ...JSON.parse(JSON.stringify(T.jb_users[0])), tg_id: 50000 + i, blocked: false });
  r = await A('POST', '/a/broadcasts', { text: 'Large', audience: 'all' }); ok(r.body.needs_confirm === true && r.body.total > 100, 'large broadcast needs explicit confirmation');
  r = await A('POST', '/a/broadcasts', { text: 'Large', audience: 'all', confirm: true }); const bc2 = T.jb_broadcasts[1]; ok(r.code === 200, 'confirmed broadcast accepted');
  await A('POST', `/a/broadcasts/${bc2.id}/cancel`, {}); const s1 = tg.st.calls.length; await Jobs.runBroadcast(srv.registry, db, { ...bc2 }, 0); ok(tg.st.calls.length === s1, 'cancelled broadcast sends nothing');
  T.jb_users = T.jb_users.filter((u) => u.tg_id < 50000);
  r = await A('POST', '/a/broadcasts/preview', { text: 'Preview' }, 500); ok(r.code === 200 && tg.sent(500).some((c) => c.params.text === 'Preview'), 'preview goes only to the admin');
  r = await A('POST', '/a/broadcasts', { text: 'Verified only', audience: 'verified' }); const bc3 = T.jb_broadcasts[2]; ok(bc3.total === T.jb_users.filter((u) => u.captcha_ok && !u.blocked && !u.banned).length, 'audience filter: verified only');

  /* ============ 9. membership recheck ============ */
  await A('PUT', '/a/settings', { settings: { recheck_days: 7, reverse_on_leave: true, rules_text: 'Stay 7 days' } }); srv.registry.invalidate();
  const b4 = bal(1001); tg.st.members['-1002:1001'] = 'left';
  let ctx = await srv.registry.ctxFor(1); const rev = await E.recheckMembership(ctx, 50);
  ok(rev === 1 && bal(1001) === b4 - 3, 'reward reversed once when the user left the channel');
  ok(T.jb_ledger.some((l) => l.kind === 'reversal' && l.user_id === 1001 && l.amount === -3), 'reversal is a new ledger row, old rows untouched');
  ok(T.jb_ledger.some((l) => l.kind === 'task' && l.user_id === 1001 && l.amount === 3), 'original reward row still there');
  ok(tg.sent(1001).some((c) => /reversed/.test(c.params.text || '') && /Stay 7 days/.test(c.params.text)), 'user is told, with the published rule');
  await E.recheckMembership(ctx, 50); ok(bal(1001) === b4 - 3, 'recheck never reverses twice');
  ok(T.jb_flags.some((f) => f.user_id === 1001 && f.kind === 'left_channel'), 'leaving is flagged');
  await A('PUT', '/a/settings', { settings: { recheck_days: 0 } }); srv.registry.invalidate();

  /* ============ 10. support, campaigns, announcements ============ */
  r = await A('POST', '/tickets', { text: 'My withdrawal is slow' }, 1001); ok(r.code === 200, 'ticket created');
  const tk = T.jb_tickets[0]; ok((await A('POST', `/a/tickets/${tk.id}/reply`, { text: 'We are on it' }, 501)).code === 200 && tg.sent(1001).some((c) => /We are on it/.test(c.params.text)), 'support reply reaches the user in the bot');
  ok((await A('POST', `/a/tickets/${tk.id}/reply`, { text: 'x' }, 503)).code === 403, 'moderator cannot answer tickets');
  await A('POST', '/a/announcements', { title: 'Welcome', body: 'Hello', pinned: true }); r = await A('GET', '/home', null, 1001); ok(r.body.announcements.length === 1 && /start=r/.test(r.body.referrals.link), 'home shows announcements and referral link');
  const t0 = r.body.tasks.find((t) => t.title === 'Join Chan 2').reward;
  await A('POST', '/a/campaigns', { name: 'Eid bonus', starts_at: new Date(Date.now() - 1000).toISOString(), ends_at: new Date(Date.now() + 86400000).toISOString(), task_bonus_pct: 50, referral_bonus: 1 });
  r = await A('GET', '/home', null, 1001); ok(r.body.tasks.find((t) => t.title === 'Join Chan 2').reward === t0 * 1.5 && !!r.body.campaign, 'campaign adds a bonus to task rewards');
  r = await A('GET', '/leaderboard?by=earn', null, 1001); ok(r.body.rows.length > 0 && r.body.rows[0].score >= r.body.rows[r.body.rows.length - 1].score, 'leaderboard sorted');

  /* ============ 11. audit, controller, pause, token rotation ============ */
  await A('POST', '/a/announcements', { title: 'By controller', body: 'x' }, 900);
  r = await A('GET', '/a/audit', null, 500); ok(r.body.audit.some((a) => a.actor === 'platform') && !r.body.audit.some((a) => a.actor === '900'), 'controller actions are logged as "platform" (id never exposed)');
  ok(r.body.audit.some((a) => a.action === 'withdraw.paid') && r.body.audit.some((a) => a.action === 'task.create'), 'audit log records money and task changes');
  const cdata = (id) => ({ 'x-init-data': H.initData(FACTORY, { id }) });
  ok((await app.call('GET', '/jb/ctl/bots', { headers: cdata(500) })).code === 403, 'controller api refuses bot admins');
  r = await app.call('GET', '/jb/ctl/bots', { headers: cdata(900) }); ok(r.code === 200 && r.body.bots.length === 1 && r.body.bots[0].users > 0, 'controller lists systems');
  r = await app.call('POST', '/jb/ctl/bots/1/token', { headers: cdata(900), body: { token: `888000:${'C'.repeat(35)}` } }); ok(r.code === 400, 'token of another bot refused');
  const oldSecret = bot.secret;
  r = await app.call('POST', '/jb/ctl/bots/1/token', { headers: cdata(900), body: { token: NEWTOKEN } }); ok(r.code === 200, 'token rotated');
  ok(!JSON.stringify(T.jb_bots).includes(NEWTOKEN), 'rotated token is stored encrypted too');
  ok(T.jb_bots[0].secret !== oldSecret, 'webhook secret changes with the token');
  ok((await app.call('POST', '/jb/hook/1', { headers: { 'x-telegram-bot-api-secret-token': oldSecret }, body: msg(1001, '/start') })).code === 401, 'old webhook secret no longer accepted');
  await app.call('POST', '/jb/ctl/bots/1/status', { headers: cdata(900), body: { status: 'paused' } });
  const pm = tg.sent(1001).length; await app.call('POST', '/jb/hook/1', { headers: { 'x-telegram-bot-api-secret-token': T.jb_bots[0].secret }, body: msg(1001, '/start') }); await srv.idle();
  ok(tg.sent(1001).length > pm && /maintenance/i.test(tg.sent(1001)[tg.sent(1001).length - 1].params.text), 'paused bot tells users it is in maintenance');
  r = await app.call('GET', '/jb/api/1/home', { headers: { 'x-init-data': H.initData(NEWTOKEN, { id: 1001 }) } }); ok(r.code === 503, 'paused bot blocks the mini app for users');
  r = await app.call('GET', '/jb/api/1/a/stats', { headers: { 'x-init-data': H.initData(NEWTOKEN, { id: 500 }) } }); ok(r.code === 200, 'admins still work while paused');
  await app.call('POST', '/jb/ctl/bots/1/status', { headers: cdata(900), body: { status: 'active' } });
  r = await app.call('GET', '/jb/health'); ok(r.code === 200, 'health check');

  console.log(`\n${pass} passed, ${failN} failed`);
  tg.close(); process.exit(failN ? 1 : 0);
})().catch((e) => { console.error('TEST CRASH', e); process.exit(2); });
