// zuck-server.mjs — Zuck, the meta model manager.
//
// A visitor brings a task request. Boss asks about everything unknown until
// the request is fully understood (or the visitor says "just plan it"), then
// defines goals, tasks, and subtasks — with gates (a task waits until its
// dependencies are done) and parallel groups (independent tasks run together)
// — and assigns each task a Meta model at a level of effort, or the user
// themselves for decisions and approvals. Then it runs the plan until the
// project is complete.
//
// Models (Meta Model API, hackathon families): Spark for text work at light /
// standard / deep effort, Wonder for the hardest planning and review, Image
// for pictures, SAM 3.1 for vision and segmentation, You for human calls.
// Only Wonder's model id (muse-wonder-1.0) is verified against Meta's API;
// the Spark / Image / SAM ids follow the same naming pattern and are shown
// on every task card, so a wrong id surfaces as the API's own error, never
// as a silent fake result.
//
// Running model tasks needs the visitor's own Meta Model API key, sent with
// the run call only. Boss never stores it, never logs it, and never puts it
// in a process argument list (it travels in a 0600 temp curl config file
// that is deleted after the call). No key means model tasks wait with their
// brief ready — Boss never pretends a model ran. Image and SAM tasks have no
// verified endpoint in v1, so with a key they run through the text model to
// produce the exact prompt / segmentation spec, labeled SPEC — the artifact
// itself still needs its own Image / SAM run, and the ship gate covers that.
//
// Runs are asynchronous by design: model calls take longer than the /u
// handler guard (20s) and the tunnel gateway allow a handler to block, so
// /zuck/run starts the run in the background and returns at once; the
// visitor watches progress with Refresh. A per-project in-progress guard
// stops two runs racing the same plan. State saves after every batch so
// polling sees tasks land as they finish.
//
// Served through the universal server as app "zuck" (see universal-server.mjs
// APP_ROUTES). State: zuck_state.json. Standalone test mode:
//   ZUCK_TEST=1 ZUCK_PORT=8105 node zuck-server.mjs
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const TEST_MODE = process.env.ZUCK_TEST === '1';
const STATE_FILE = join(HERE, TEST_MODE ? 'zuck_state_test.json' : 'zuck_state.json');
const SESSION_FILE = join(HERE, TEST_MODE ? 'zuck_sessions_test.json' : 'zuck_sessions.json');
const UA = 'Mozilla/5.0 (Zuck; handoff.lol miniapp)';

const MODELS = {
  spark: { label: 'Spark', id: 'muse-spark-1.3', note: 'text work' },
  wonder: { label: 'Wonder', id: 'muse-wonder-1.0', note: 'hardest planning and review' },
  image: { label: 'Image', id: 'muse-image-1.0', note: 'pictures' },
  sam: { label: 'SAM 3.1', id: 'sam-3.1', note: 'vision and segmentation' },
  user: { label: 'You', id: '', note: 'human call' },
};

const DIMS = [
  { dim: 'who', q: 'Who is this for? Who will use it?' },
  { dim: 'platform', q: 'Where does it live? A handoff miniapp, a website, a phone app, something else?' },
  { dim: 'must', q: 'What must it definitely do? Name the must-haves.' },
  { dim: 'look', q: 'How should it feel to use? Plain words are fine.' },
  { dim: 'limits', q: 'Any deadline, budget, or limits I should know about?' },
  { dim: 'done', q: 'How will you know it is done? What does finished look like?' },
];

function load() {
  try { const s = JSON.parse(readFileSync(STATE_FILE, 'utf8')); if (s && s.projects) return s; } catch {}
  return { projects: {} };
}
let state = load();
function save() {
  try { const tmp = STATE_FILE + '.tmp'; writeFileSync(tmp, JSON.stringify(state)); renameSync(tmp, STATE_FILE); } catch {}
}

// ---------- handoff sign-in sessions (server-side only) ----------
// A session id rides in the page URL (?sid=...). Sessions live here:
// {sid: {user, ts}}. Sign-in comes from handoff's own panel (HandoffAuth);
// the browser sends its handoff token once for verification (see
// session-start) and the token itself is never kept.
function loadSessions() {
  try { const s = JSON.parse(readFileSync(SESSION_FILE, 'utf8')); if (s && typeof s === 'object') return s; } catch {}
  return {};
}
function saveSessions(s) {
  try { const tmp = SESSION_FILE + '.tmp'; writeFileSync(tmp, JSON.stringify(s)); renameSync(tmp, SESSION_FILE); } catch {}
}
const newSid = () => 's-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
// Native handoff sign-in (HandoffAuth panel in the miniapp) verified here:
// the browser sends its handoff token ONCE; this server checks it against
// handoff's own /api/v1/auth/me and, on success, mints a Zuck session id.
// The handoff token is used for that one check only — never stored, never
// logged, never written to state. Sessions on disk hold {user, ts} only.
function curlGetJson(url, bearer) {
  return new Promise((resolve) => {
    execFile('curl', ['-s', '-A', UA, '--max-time', '15', '-H', 'Authorization: Bearer ' + bearer, url],
      { maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(null);
      resolve(tolerantParse(stdout));
    });
  });
}
async function verifyHandoffToken(token) {
  const d = await curlGetJson('https://handoff.lol/api/v1/auth/me', token);
  if (d && d.success && d.user) {
    const name = d.user.handle || d.user.username || d.user.id;
    if (name) return String(name).slice(0, 60);
  }
  return null;
}
function sessionProjects(sid) {
  return Object.values(state.projects)
    .filter((x) => x.owner === sid)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .map((x) => ({ id: x.id, request: x.request, status: x.status, created_at: x.created_at }));
}
const tok = (n = 6) => randomBytes(n).toString('hex');
const nowIso = () => new Date().toISOString();

const hits = new Map();
function rateOk(ip, action, n, windowMs) {
  const k = ip + ':' + action, now = Date.now();
  const arr = (hits.get(k) || []).filter((t) => now - t < windowMs);
  arr.push(now); hits.set(k, arr);
  return arr.length <= n;
}
function clientIp(req) {
  return String(req.headers['cf-connecting-ip'] || req.socket?.remoteAddress || '127.0.0.1');
}
function readBody(req, cap) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > cap) { reject(new Error('too large')); try { req.destroy(); } catch {} } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function tolerantParse(s) {
  try { return JSON.parse(s); } catch {}
  try { return JSON.parse(String(s).replace(/[\u0000-\u001F]+/g, ' ')); } catch {}
  return null;
}
function titleOf(request) {
  const s = String(request || '').replace(/\s+/g, ' ').trim();
  const first = s.split(/(?<=[.!?])\s/)[0] || s;
  return first.length > 70 ? first.slice(0, 67) + '...' : first;
}
function answersText(p) {
  return p.answers.map((a) => a.dim + ': ' + a.a).join('\n');
}

function buildPlan(p) {
  const title = titleOf(p.request);
  const hay = (p.request + ' ' + answersText(p)).toLowerCase();
  const who = (p.answers.find((a) => a.dim === 'who') || {}).a || 'the people using it';
  const goals = [
    { id: 'g1', text: 'Build: ' + title },
    { id: 'g2', text: 'Make it work for ' + who },
    { id: 'g3', text: 'Ship it and prove it works' },
  ];
  const brief = (purpose) => 'Project: ' + title + '.\nWhat you said:\n' + (answersText(p) || 'nothing yet — working from the request alone.') + '\nJob: ' + purpose;
  const tasks = [];
  tasks.push({ id: 't1', goal: 'g1', title: 'Define the build', model: 'spark', effort: 'standard', kind: 'model',
    deps: [], parallel: '', subtasks: ['Write the build spec from your answers', 'List what it must do and what it will not do', 'Name the pieces it needs'],
    brief: brief('Turn the request and answers into a build spec the rest of the plan can follow.'), status: 'todo', result: '', error: '' });
  const buildIds = [];
  if (/image|picture|photo|visual|logo|art|illustrat/.test(hay)) {
    tasks.push({ id: 't-img', goal: 'g1', title: 'Draft every picture it needs', model: 'image', effort: 'standard', kind: 'model',
      deps: ['t1'], parallel: 'build', subtasks: ['Describe each picture it needs', 'Draft the exact prompt for each', 'Settle the set'],
      brief: brief('Draft the exact prompts for every picture this project needs. This produces the prompt set, not the pictures themselves.'), status: 'todo', result: '', error: '' });
    buildIds.push('t-img');
  }
  if (/segment|detect|vision|scan|photo analysis|find in (the )?pictures?/.test(hay)) {
    tasks.push({ id: 't-vis', goal: 'g1', title: 'Plan the vision work', model: 'sam', effort: 'standard', kind: 'model',
      deps: ['t1'], parallel: 'build', subtasks: ['List what to find in the pictures', 'Draft the segmentation plan', 'Settle the plan'],
      brief: brief('Draft the segmentation plan: what to find in the pictures and how to cut them up. This produces the plan, not the segments themselves.'), status: 'todo', result: '', error: '' });
    buildIds.push('t-vis');
  }
  tasks.push({ id: 't2', goal: 'g1', title: 'Build the main piece', model: 'spark', effort: 'deep', kind: 'model',
    deps: ['t1'], parallel: 'build', subtasks: ['Build the main piece', 'Wire the pieces together', 'Fix what breaks'],
    brief: brief('Do the main build work, following the spec from the define step.'), status: 'todo', result: '', error: '' });
  buildIds.push('t2');
  tasks.push({ id: 't3', goal: 'g2', title: 'Check it against your must-haves', model: 'wonder', effort: 'standard', kind: 'model',
    deps: buildIds, parallel: '', subtasks: ['Check it against your must-haves', 'Find the weak spots', 'List what to fix'],
    brief: brief('Review the built work against the must-haves and name every gap. Nothing ships until this passes.'), status: 'todo', result: '', error: '' });
  tasks.push({ id: 't4', goal: 'g3', title: 'You look it over and say go', model: 'user', effort: '', kind: 'user',
    deps: ['t3'], parallel: '', subtasks: ['Look it over', 'Say go, or list fixes'],
    brief: 'Your call: look over everything the plan produced and say go, or list what still needs fixing.', status: 'todo', result: '', error: '' });
  return { goals, tasks };
}

function publicProject(p) {
  return {
    id: p.id, request: p.request, answers: p.answers, qi: p.qi,
    question: p.qi < DIMS.length ? DIMS[p.qi].q : null,
    unknowns: DIMS.slice(p.qi).map((d) => d.dim),
    status: p.status, plan: p.plan, created_at: p.created_at,
  };
}

// Call Meta Model API /v1/responses via curl. The key travels in a 0600 temp
// config file (never argv, never disk state, never logs) and is deleted after.
function callModel(modelId, input, key) {
  return new Promise((resolve) => {
    const cfg = join(HERE, '.zuck-key-' + tok(4));
    try { writeFileSync(cfg, 'header = "Authorization: Bearer ' + String(key).replace(/["\\\n\r]/g, '') + '"\n', { mode: 0o600 }); } catch { return resolve({ ok: false, error: 'could not stage the key' }); }
    const body = JSON.stringify({ model: modelId, input: String(input).slice(0, 8000) });
    execFile('curl', ['-s', '-A', UA, '--max-time', '60', '-K', cfg, '-H', 'content-type: application/json',
      '-d', body, 'https://api.meta.ai/v1/responses'], { maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        try { unlinkSync(cfg); } catch {}
        if (err) return resolve({ ok: false, error: 'Meta did not answer — try again in a bit' });
        const j = tolerantParse(stdout);
        if (!j) return resolve({ ok: false, error: 'Meta answered in a shape Boss could not read' });
        if (j.error) return resolve({ ok: false, error: String(j.error.message || j.error.code || 'Meta refused the call') });
        const texts = [];
        const walk = (o) => {
          if (!o) return;
          if (typeof o === 'string') return;
          if (Array.isArray(o)) { o.forEach(walk); return; }
          if (typeof o.text === 'string' && o.type && String(o.type).includes('text')) texts.push(o.text);
          Object.values(o).forEach(walk);
        };
        walk(j.output);
        const text = texts.join('\n').trim();
        if (!text) return resolve({ ok: false, error: 'Meta answered with no text' });
        resolve({ ok: true, text: text.slice(0, 8000) });
      });
  });
}

async function runPlan(p, key) {
  const plan = p.plan;
  if (!plan) return;
  const byId = Object.fromEntries(plan.tasks.map((t) => [t.id, t]));
  // A task is runnable when its dependencies are done and it is not already
  // done or waiting on the user. Error and needs_key tasks retry on the
  // next run; waiting_user tasks only move when the user confirms them.
  const ready = () => plan.tasks.filter((t) => (t.status === 'todo' || t.status === 'error' || t.status === 'needs_key')
    && t.deps.every((d) => byId[d] && byId[d].status === 'done'));
  for (;;) {
    const batch = ready();
    if (!batch.length) break;
    const jobs = batch.map(async (t) => {
      if (t.kind === 'user') { t.status = 'waiting_user'; return; }
      if (!key) { t.status = 'needs_key'; return; }
      let modelId = MODELS[t.model].id;
      let specNote = '';
      if (t.model === 'image' || t.model === 'sam') {
        modelId = MODELS.spark.id;
        specNote = 'SPEC — drafted by Spark. The ' + MODELS[t.model].label + ' run itself still needs its own endpoint.';
      }
      const r = await callModel(modelId, t.brief + '\nSubtasks:\n- ' + t.subtasks.join('\n- '), key);
      if (r.ok) {
        t.status = 'done';
        t.result = (specNote ? specNote + '\n\n' : '') + r.text;
        t.error = '';
      } else {
        t.status = 'error';
        t.error = r.error;
      }
    });
    await Promise.all(jobs);
    save();
    // Advance only if a model task finished in this batch; otherwise the
    // remaining tasks are blocked on user confirmation, a key, or an error.
    if (!batch.some((t) => t.status === 'done')) break;
  }
  p.status = plan.tasks.every((t) => t.status === 'done') ? 'done' : 'running';
  save();
}

const running = new Set();

export function createZuckHandler() {
  return async function handleBoss(req, res, path, url) {
    if (!path.startsWith('/zuck')) return false;
    const json = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify(obj));
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type' });
      res.end(); return true;
    }
    const ip = clientIp(req);

    if (path === '/zuck' && req.method === 'GET') {
      json(200, { ok: true, name: 'zuck', version: 1, models: Object.fromEntries(Object.entries(MODELS).map(([k, v]) => [k, v.label])) });
      return true;
    }
    if (path === '/zuck/project' && req.method === 'GET') {
      const p = state.projects[String(url.searchParams.get('pid') || '')];
      const sid = String(url.searchParams.get('sid') || '');
      if (!p || (p.owner && p.owner !== sid)) { json(404, { ok: false, error: 'no such project' }); return true; }
      json(200, { ok: true, project: publicProject(p) }); return true;
    }
    if (req.method !== 'POST' || !['/zuck/start', '/zuck/answer', '/zuck/plan', '/zuck/run', '/zuck/confirm', '/zuck/session-start', '/zuck/session', '/zuck/signout'].includes(path)) {
      json(404, { ok: false, error: 'no such zuck action' }); return true;
    }
    const body = await readBody(req, 65536);
    let j = {}; try { j = JSON.parse(body || '{}'); } catch {}

    if (path === '/zuck/start') {
      if (!rateOk(ip, 'start', 10, 3600e3)) { json(429, { ok: false, error: 'slow down a little' }); return true; }
      const request = String(j.request || '').trim();
      if (!request) { json(200, { ok: false, error: 'tell Zuck what you want to build first' }); return true; }
      const sidClaim = String(j.sid || '');
      const owner = sidClaim && loadSessions()[sidClaim] ? sidClaim : null;
      const p = { id: 'zuck-' + tok(3), request, answers: [], qi: 0, status: 'clarifying', plan: null, created_at: nowIso(), owner };
      state.projects[p.id] = p; save();
      json(200, { ok: true, project: publicProject(p) }); return true;
    }
    // Auth actions carry no project; only the project actions look one up.
    let p = null;
    if (['/zuck/answer', '/zuck/plan', '/zuck/run', '/zuck/confirm'].includes(path)) {
      p = state.projects[String(j.pid || '')];
      if (!p) { json(404, { ok: false, error: 'no such project — start one first' }); return true; }
      if (p.owner && p.owner !== String(j.sid || '')) { json(403, { ok: false, error: 'that project belongs to another signed-in user' }); return true; }
    }

    if (path === '/zuck/answer') {
      if (!rateOk(ip, 'answer', 60, 60e3)) { json(429, { ok: false, error: 'slow down a little' }); return true; }
      const text = String(j.text || '').trim();
      const skip = /^(skip|pass|dont know|don't know|dunno)$/i.test(text);
      if (p.qi < DIMS.length) {
        if (!skip && text) p.answers.push({ dim: DIMS[p.qi].dim, q: DIMS[p.qi].q, a: text });
        p.qi += 1;
        if (p.qi >= DIMS.length) p.status = 'ready_to_plan';
        save();
      }
      json(200, { ok: true, project: publicProject(p) }); return true;
    }
    if (path === '/zuck/plan') {
      if (!rateOk(ip, 'plan', 10, 3600e3)) { json(429, { ok: false, error: 'slow down a little' }); return true; }
      p.plan = buildPlan(p);
      p.status = 'planned';
      save();
      json(200, { ok: true, project: publicProject(p) }); return true;
    }
    if (path === '/zuck/run') {
      if (!rateOk(ip, 'run', 5, 3600e3)) { json(429, { ok: false, error: 'Boss runs a plan at most 5 times an hour per address' }); return true; }
      if (!p.plan) { json(200, { ok: false, error: 'plan it first' }); return true; }
      if (running.has(p.id)) { json(200, { ok: false, error: 'a run is already going for this project — refresh to see progress' }); return true; }
      const key = String(j.key || '').trim();
      running.add(p.id);
      runPlan(p, key || null).finally(() => running.delete(p.id));
      json(200, { ok: true, started: true, project: publicProject(p), key_used: !!key }); return true;
    }
    if (path === '/zuck/confirm') {
      if (!rateOk(ip, 'confirm', 60, 60e3)) { json(429, { ok: false, error: 'slow down a little' }); return true; }
      const t = (p.plan || { tasks: [] }).tasks.find((x) => x.id === String(j.taskId || ''));
      if (!t) { json(404, { ok: false, error: 'no such task' }); return true; }
      if (t.status !== 'waiting_user') { json(200, { ok: false, error: 'that task is not waiting on you' }); return true; }
      t.status = 'done';
      t.result = 'Confirmed by you.';
      p.status = p.plan.tasks.every((x) => x.status === 'done') ? 'done' : 'running';
      save();
      json(200, { ok: true, project: publicProject(p) }); return true;
    }
    if (path === '/zuck/session-start') {
      const token = String(j.token || '').slice(0, 2000);
      if (!token) { json(200, { ok: false, error: 'token required' }); return true; }
      let username = null;
      try { username = await verifyHandoffToken(token); }
      catch (e) { username = null; }
      if (!username) { json(200, { ok: false, error: 'handoff did not accept that sign-in — try signing in again' }); return true; }
      const sid = newSid();
      const sessions = loadSessions();
      sessions[sid] = { user: username, ts: nowIso() };
      saveSessions(sessions);
      json(200, { ok: true, user: username, sid, projects: sessionProjects(sid) }); return true;
    }
    if (path === '/zuck/session') {
      const sid = String(j.sid || '').slice(0, 80);
      const sessions = loadSessions();
      const sess = sessions[sid];
      if (!sess) { json(200, { ok: false }); return true; }
      json(200, { ok: true, user: sess.user || null, projects: sessionProjects(sid) }); return true;
    }
    if (path === '/zuck/signout') {
      const sid = String(j.sid || '').slice(0, 80);
      const sessions = loadSessions();
      delete sessions[sid];
      saveSessions(sessions);
      json(200, { ok: true }); return true;
    }
    json(404, { ok: false, error: 'no such zuck action' }); return true;
  };
}

if (TEST_MODE) {
  const port = Number(process.env.ZUCK_PORT || 8105);
  const handler = createZuckHandler();
  const srv = createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const handled = await handler(req, res, u.pathname, u);
    if (!handled) { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'not zuck' })); }
  });
  srv.listen(port, '127.0.0.1', () => console.log('zuck-server (standalone) on 127.0.0.1:' + port + ' [TEST MODE]'));
}
