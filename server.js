// Join & Earn / Task & Rewards platform. Run: node server.js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { handleUpdate } = require('./lib/bot');
const { createApi } = require('./lib/tg');
const Api = require('./lib/api');
const Jobs = require('./lib/jobs');
const Ctl = require('./lib/controller');
const createRegistry = require('./lib/registry');

const factorySecret = (token) => crypto.createHmac('sha256', process.env.TOKEN_KEY || 'x').update(`factory:${token || ''}`).digest('hex').slice(0, 32);

function mountAll(app, { db, publicUrl, factoryToken }) {
  const registry = createRegistry(db, publicUrl);
  const inflight = new Set();                      // lets tests wait for background work
  const track = (p) => { inflight.add(p); p.finally(() => inflight.delete(p)); return p; };
  const html = () => fs.readFileSync(path.join(__dirname, 'public', 'app.html'), 'utf8');

  app.get('/jb/health', (req, res) => res.json({ ok: true }));
  app.get('/jb/app/:botId', (req, res) => { res.set('Cache-Control', 'no-cache'); res.type('html').send(html()); });

  // Telegram -> bot (one webhook per bot, protected by that bot's own secret)
  app.post('/jb/hook/:botId', async (req, res) => {
    const ctx = await registry.ctxFor(req.params.botId).catch(() => null);
    if (!ctx || req.get('x-telegram-bot-api-secret-token') !== ctx.bot.secret) return res.status(401).json({ ok: false });
    res.json({ ok: true });                       // answer Telegram first, work afterwards
    track(handleUpdate(ctx, req.body || {}).catch((e) => console.error(`bot ${ctx.bot.id} update error:`, e.message)));
  });

  if (factoryToken) {
    const fapi = createApi(factoryToken);
    app.post('/jb/factory/:secret', (req, res) => {
      if (req.params.secret !== factorySecret(factoryToken)) return res.status(401).json({ ok: false });
      res.json({ ok: true });
      track(Ctl.handleFactoryUpdate({ db, registry, publicUrl }, fapi, req.body || {}).catch((e) => console.error('factory error:', e.message)));
    });
  }
  Api.mount(app, { db, registry, publicUrl, factoryToken });
  return { registry, idle: async () => { while (inflight.size) await Promise.all([...inflight]); } };
}

async function main() {
  const express = require('express');
  const { createClient } = require('@supabase/supabase-js');
  const need = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'TOKEN_KEY', 'PUBLIC_URL'];
  const missing = need.filter((k) => !process.env[k]);
  if (missing.length) { console.error(`Missing environment variables: ${missing.join(', ')}. See .env.example`); process.exit(1); }
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
  const publicUrl = String(process.env.PUBLIC_URL).replace(/\/+$/, '');
  const factoryToken = process.env.FACTORY_BOT_TOKEN || '';

  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '300kb' }));
  const { registry } = mountAll(app, { db, publicUrl, factoryToken });
  Jobs.start(registry, db);

  if (factoryToken) {
    createApi(factoryToken).call('setWebhook', { url: `${publicUrl}/jb/factory/${factorySecret(factoryToken)}`, allowed_updates: ['message'] })
      .then(() => console.log('Controller bot webhook set')).catch((e) => console.error('Controller webhook failed:', e.message));
  }
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => console.log(`Join & Earn platform listening on ${port}`));
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { mountAll, factorySecret };
