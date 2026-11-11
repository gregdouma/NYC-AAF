const OFFICIAL_AAF_URL = 'https://egud.fa.us2.oraclecloud.com/fscmUI/redwood/aafFormUI';
const INITIAL_CONFIG = {
  title: 'NYC Gives Back',
  donationUrl: OFFICIAL_AAF_URL,
  goal: 5000,
  mode: 'regional',
  teams: Array.from({length: 11}, (_, i) => `District ${i + 1}`),
  showMilestones: false,
  milestones: [500, 1000, 2500, 5000],
};

const reply = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
  }
});
const problem = (error, status = 400) => reply({error}, status);
const hdrs = {
  'X-Content-Type-Options':'nosniff',
  'Referrer-Policy':'strict-origin-when-cross-origin',
  'X-Frame-Options':'DENY',
  'Permissions-Policy':'camera=(), microphone=(), geolocation=()'
};
async function configOf(db) {
  const r = await db.prepare('SELECT value FROM settings WHERE key = ?').bind('event').first();
  if (!r) return INITIAL_CONFIG;
  try { return JSON.parse(r.value); } catch { return INITIAL_CONFIG; }
}
function safeName(s) { return typeof s === 'string' && s.trim().length > 0 && s.trim().length <= 55; }
function sameOrigin(req) {
  const origin = req.headers.get('origin');
  return !origin || origin === new URL(req.url).origin;
}
function isAdmin(req, env) {
  const secret = env.ADMIN_TOKEN;
  return Boolean(secret && secret.length >= 24 && req.headers.get('authorization') === `Bearer ${secret}`);
}
async function sha256Hex(buf) {
  const sha = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(sha)].map(v => v.toString(16).padStart(2,'0')).join('');
}
function validFile(bytes, type) {
  const b = new Uint8Array(bytes);
  if (type === 'image/jpeg') return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (type === 'image/png') return b[0] === 137 && b[1] === 80 && b[2] === 78 && b[3] === 71;
  if (type === 'image/webp') return String.fromCharCode(...b.slice(0,4)) === 'RIFF' && String.fromCharCode(...b.slice(8,12)) === 'WEBP';
  return false;
}
async function summary(db) {
  const config = await configOf(db);
  const rows = await db.prepare(`SELECT team, COUNT(*) AS donation_count, COALESCE(SUM(amount_cents),0) AS cents
    FROM donations WHERE status = 'approved' GROUP BY team`).all();
  const teamMap = new Map(rows.results.map(r => [r.team, {name:r.team, count:r.donation_count, amount:r.cents / 100}]));
  const teams = [...new Set([...config.teams, ...teamMap.keys()])].map(name => teamMap.get(name) || {name, count:0, amount:0});
  const total = rows.results.reduce((a,b) => a + b.cents,0) / 100;
  const count = rows.results.reduce((a,b) => a + b.donation_count,0);
  const pending = (await db.prepare("SELECT COUNT(*) AS n FROM donations WHERE status = 'pending'").first()).n;
  const recent = await db.prepare("SELECT team, amount_cents, reviewed_at FROM donations WHERE status = 'approved' ORDER BY reviewed_at DESC LIMIT 6").all();
  // Activity is a proxy for unique devices in the meeting flow, not Oracle payment activity.
  // Screen engagement lasts 90 seconds; a tap to open the official site lasts 10 minutes.
  const activeRow = await db.prepare(`SELECT COUNT(*) AS n FROM activity_sessions
    WHERE stage != 'submitted' AND (
      (stage IN ('view', 'upload') AND last_seen >= unixepoch() - 90)
      OR (clicked_at IS NOT NULL AND clicked_at >= unixepoch() - 600)
    )`).first();
  return {config, teams, total, count, activeCount: Number(activeRow?.n || 0), pending, recent:recent.results.map(r=>({team:r.team, amount:r.amount_cents/100, at:r.reviewed_at}))};
}
async function handleApi(req, env, path) {
  if (!env.DB || !env.RECEIPTS) return problem('Database or private receipt storage is not configured.', 503);
  const method = req.method.toUpperCase();
  if (method !== 'GET' && !sameOrigin(req)) return problem('Invalid request origin.',403);
  if (method === 'GET' && path === '/api/config') return reply(await configOf(env.DB));
  if (method === 'GET' && path === '/api/summary') return reply(await summary(env.DB));

  if (method === 'POST' && path === '/api/activity') {
    // This endpoint never identifies employees or records which page they see on Oracle.
    // A per-tab UUID is generated on the event page; repeated taps count once.
    let body;
    try { body = await req.json(); } catch { return problem('Invalid activity signal.'); }
    const sessionId = body?.sessionId;
    const stage = body?.stage;
    if (typeof sessionId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId)) return problem('Invalid activity session.');
    if (!['view', 'donate', 'upload', 'submitted'].includes(stage)) return problem('Invalid activity stage.');
    // Do not reactivate a session that has completed a submission.
    await env.DB.prepare(`INSERT INTO activity_sessions(session_id,last_seen,clicked_at,stage)
      VALUES (?, unixepoch(), CASE WHEN ? = 'donate' THEN unixepoch() ELSE NULL END, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        last_seen = CASE WHEN activity_sessions.stage = 'submitted' THEN activity_sessions.last_seen ELSE unixepoch() END,
        clicked_at = CASE WHEN activity_sessions.stage = 'submitted' THEN activity_sessions.clicked_at WHEN excluded.stage = 'donate' THEN unixepoch() ELSE activity_sessions.clicked_at END,
        stage = CASE WHEN activity_sessions.stage = 'submitted' THEN 'submitted' ELSE excluded.stage END`)
      .bind(sessionId, stage, stage).run();
    // Opportunistic cleanup, avoiding unnecessary retention of old anonymous IDs.
    // Run only intermittently so every phone heartbeat doesn't trigger a full delete.
    if (Math.random() < 0.025) await env.DB.prepare('DELETE FROM activity_sessions WHERE last_seen < unixepoch() - 86400').run();
    return reply({ok:true});
  }

  if (method === 'POST' && path === '/api/submit') {
    const length = Number(req.headers.get('content-length') || 0);
    if (length > 6 * 1024 * 1024) return problem('File too large. Choose an image under 5 MB.',413);
    let data;
    try { data = await req.formData(); } catch { return problem('Unable to read the upload.'); }
    const file = data.get('proof');
    const team = data.get('team');
    const cfg = await configOf(env.DB);
    const effectiveTeam = cfg.mode === 'team' ? team : 'NYC Region';
    if (cfg.mode === 'team' && (typeof team !== 'string' || !cfg.teams.includes(team))) return problem('Please choose a team.');
    if (!file || typeof file.arrayBuffer !== 'function' || file.size < 100 || file.size > 5 * 1024 * 1024) return problem('Upload a screenshot under 5 MB.');
    const mime = file.type.toLowerCase();
    if (!['image/jpeg','image/png','image/webp'].includes(mime)) return problem('Use a PNG, JPG, or WebP screenshot.');
    const bytes = await file.arrayBuffer();
    if (!validFile(bytes,mime)) return problem('The upload is not a valid image.');
    const hash = await sha256Hex(bytes);
    const id = crypto.randomUUID();
    const key = `proof/${id}`;
    try {
      await env.DB.prepare(`INSERT INTO donations (id, team, object_key, image_hash, filename, mime_type, file_size)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(id, effectiveTeam, key, hash, (file.name || 'screenshot').slice(0,120), mime, file.size).run();
    } catch (e) {
      if (String(e).includes('UNIQUE')) return problem('This exact screenshot was already submitted.',409);
      throw e;
    }
    try { await env.RECEIPTS.put(key, bytes, {httpMetadata:{contentType:mime}}); }
    catch (e) { await env.DB.prepare('DELETE FROM donations WHERE id = ?').bind(id).run(); throw e; }
    return reply({ok:true, id, message:'Screenshot received for review.'},201);
  }

  if (path.startsWith('/api/admin/')) {
    if (!isAdmin(req, env)) return problem('Administrator access required.',401);
    if (method === 'GET' && path === '/api/admin/queue') {
      const q = await env.DB.prepare(`SELECT id, team, status, amount_cents, submitted_at, reviewed_at, reviewer_note, mime_type
        FROM donations ORDER BY CASE WHEN status = 'pending' THEN 0 ELSE 1 END, submitted_at DESC LIMIT 200`).all();
      return reply({donations:q.results});
    }
    if (method === 'GET' && /^\/api\/admin\/receipt\/[\w-]+$/.test(path)) {
      const id = path.split('/').pop();
      const item = await env.DB.prepare('SELECT object_key, mime_type FROM donations WHERE id = ?').bind(id).first();
      if (!item) return problem('Not found.',404);
      const object = await env.RECEIPTS.get(item.object_key);
      if (!object) return problem('Image missing.',404);
      return new Response(object.body,{headers:{'Content-Type':item.mime_type,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
    }
    if (method === 'POST' && path === '/api/admin/review') {
      let body;
      try { body = await req.json(); } catch { return problem('Invalid data.'); }
      if (!body || typeof body.id !== 'string' || !['approved','rejected','pending'].includes(body.status)) return problem('Invalid review.');
      let cents = null;
      if (body.status === 'approved') {
        const n = Number(body.amount);
        if (!Number.isFinite(n) || n <= 0 || n > 10000 || Math.abs(Math.round(n * 100) - n * 100) > 0.00001) return problem('Enter a valid donation amount, up to $10,000.');
        cents = Math.round(n*100);
      }
      const note = typeof body.note === 'string' ? body.note.slice(0,250) : '';
      const update = await env.DB.prepare(`UPDATE donations SET status=?, amount_cents=?, reviewer_note=?, reviewed_at = CASE WHEN ? = 'pending' THEN NULL ELSE datetime('now') END WHERE id=?`)
        .bind(body.status,cents,note,body.status,body.id).run();
      if (!update.meta.changes) return problem('Submission not found.',404);
      return reply({ok:true});
    }
    if (method === 'POST' && path === '/api/admin/config') {
      let body;
      try { body = await req.json(); } catch { return problem('Invalid data.'); }
      if (!body || !Array.isArray(body.teams) || body.teams.length < 1 || body.teams.length > 25 || !body.teams.every(safeName)) return problem('Enter 1–25 valid team names.');
      const teams = body.teams.map(s => s.trim());
      if (new Set(teams).size !== teams.length) return problem('Team names must be unique.');
      const goal = Number(body.goal);
      const milestones = Array.isArray(body.milestones) ? body.milestones.map(Number) : null;
      if (!Number.isFinite(goal) || goal <= 0 || goal > 1000000 || !milestones || milestones.length > 20 || milestones.some(m => !Number.isFinite(m) || m <= 0 || m > 1000000)) return problem('Invalid goal or milestones.');
      const cfg = {
        mode: body.mode === 'team' ? 'team' : 'regional',
        showMilestones: body.showMilestones === true,
        title: safeName(body.title) ? body.title.trim() : INITIAL_CONFIG.title,
        donationUrl: OFFICIAL_AAF_URL,
        goal, teams, milestones:[...new Set(milestones)].sort((a,b)=>a-b)
      };
      await env.DB.prepare("INSERT INTO settings (key,value) VALUES ('event',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(JSON.stringify(cfg)).run();
      return reply({ok:true,config:cfg});
    }
    if (method === 'POST' && path === '/api/admin/manual') {
      let body;
      try { body = await req.json(); } catch { return problem('Invalid data.'); }
      const n = Number(body.amount);
      if (!Number.isFinite(n) || n <= 0 || n > 10000 || Math.abs(Math.round(n*100)-n*100) > 0.00001) return problem('Enter a valid donation amount.');
      const cfg = await configOf(env.DB);
      const team = cfg.mode === 'team' && cfg.teams.includes(body.team) ? body.team : 'NYC Region';
      const id = crypto.randomUUID();
      await env.DB.prepare(`INSERT INTO donations (id,team,object_key,image_hash,filename,mime_type,file_size,status,amount_cents,reviewed_at,reviewer_note)
        VALUES (?,?,?,?,?,?,?,'approved',?,datetime('now'),?)`)
        .bind(id,team,`manual/${id}`,`manual:${id}`,'Manual verified entry','manual',0,Math.round(n*100),String(body.note||'Verified by event organizer; no screenshot uploaded').slice(0,250)).run();
      return reply({ok:true,id},201);
    }
    if (method === 'DELETE' && /^\/api\/admin\/donation\/[\w-]+$/.test(path)) {
      const id = path.split('/').pop();
      const item = await env.DB.prepare('SELECT object_key FROM donations WHERE id = ?').bind(id).first();
      if (!item) return problem('Not found.',404);
      await env.DB.prepare('DELETE FROM donations WHERE id = ?').bind(id).run();
      await env.RECEIPTS.delete(item.object_key);
      return reply({ok:true});
    }
  }
  return problem('Not found.',404);
}
export default {
  async fetch(req, env) {
    try {
      const url = new URL(req.url);
      if (url.pathname.startsWith('/api/')) return await handleApi(req,env,url.pathname);
      if (!env.ASSETS) return new Response('Static assets are not configured.',{status:503});
      const response = await env.ASSETS.fetch(req);
      const headers = new Headers(response.headers);
      for (const [k,v] of Object.entries(hdrs)) headers.set(k,v);
      if (url.pathname === '/' || url.pathname.endsWith('.html')) headers.set('Cache-Control','no-cache');
      // This is a donation reporting app, not the corporate payment page.
      headers.set('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data: https://quickchart.io; connect-src 'self'; form-action 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
      return new Response(response.body,{status:response.status,headers});
    } catch (e) {
      return problem('A temporary server error occurred. Please try again or contact the event administrator.',500);
    }
  }
};
