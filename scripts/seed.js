// Optional sample data for a bot that is already connected:  BOT_ID=1 node scripts/seed.js
// Adds an announcement, a sample "visit" task, a sample "custom" task and a campaign you can edit or delete in the admin panel.
const { createClient } = require('@supabase/supabase-js');
(async () => {
  const bot = Number(process.env.BOT_ID);
  if (!bot || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) { console.error('Set BOT_ID, SUPABASE_URL and SUPABASE_SERVICE_KEY.'); process.exit(1); }
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
  const ok = (r) => { if (r.error) throw new Error(r.error.message); };
  ok(await db.from('jb_announcements').insert({ bot_id: bot, title: 'Welcome!', body: 'Complete tasks, invite friends and earn ETB rewards.', pinned: true }));
  ok(await db.from('jb_tasks').insert([
    { bot_id: bot, type: 'visit', title: 'Read our guide', description: 'Open the page for 10 seconds.', url: 'https://example.com', reward: 1, min_seconds: 10, sort: 5 },
    { bot_id: bot, type: 'custom', title: 'Share our banner', description: 'Post it in a group and send us the link.', reward: 5, requires_review: true, sort: 6 },
  ]));
  ok(await db.from('jb_campaigns').insert({ bot_id: bot, name: 'Launch week', starts_at: new Date().toISOString(), ends_at: new Date(Date.now() + 7 * 86400000).toISOString(), task_bonus_pct: 25, referral_bonus: 0 }));
  console.log('Sample data added. Join-channel tasks are created in the admin panel after you connect a channel.');
})().catch((e) => { console.error(e.message); process.exit(1); });
