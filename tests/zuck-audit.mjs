// Zuck v1.1 interaction audit (PM board layout) against the throwaway test
// server (127.0.0.1:8105) and the served test page (127.0.0.1:8104).
// Every control must show a visible effect; gates must hold; no fake
// completions without a key. Save/exit is tested with a seeded test session
// (test state only); the sign-in panel itself is handoff's own modal and is
// verified opening on the live page, not here.
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
const URL = 'http://127.0.0.1:8104/zuck-test-page.html';
let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? ' :: ' + extra : '')); ok ? pass++ : fail++; };
const errors = [];

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(1200);

check('hero h1 Zuck', (await page.textContent('h1')) === 'Zuck');
check('footer logo mark present', (await page.$('#zuckMark')) !== null);
check('header carries no avatar', (await page.$('header svg')) === null);
check('sign-in button present', (await page.textContent('#authArea')).includes('Sign in with handoff'));

// sign-in click on the test page shows a visible, honest note (no panel here)
await page.locator('#authArea button').click();
await page.waitForTimeout(500);
check('sign-in click shows visible note on test page', (await page.textContent('#startErr')).includes('live page'));

// empty request blocked visibly
await page.click('#startBtn');
await page.waitForTimeout(500);
check('empty request blocked visibly', (await page.textContent('#startErr')).includes('Tell Zuck what you want built first'));

// start -> QA
await page.fill('#requestInput', 'a VR gallery where visitors walk through rooms of AI art');
await page.click('#startBtn');
await page.waitForSelector('#qaPanel:not(.hidden)', { timeout: 10000 }).catch(() => {});
check('start shows first question', (await page.textContent('#questionText')).includes('Who is this for'));

// answer + skip + plan it now
await page.fill('#answerInput', 'people who like art');
await page.click('#answerBtn');
await page.waitForFunction(() => document.getElementById('questionText').textContent.includes('Where does it live'), null, { timeout: 10000 }).catch(() => {});
check('answer advances', (await page.textContent('#questionText')).includes('Where does it live'));
await page.click('#skipBtn');
await page.waitForFunction(() => document.getElementById('questionText').textContent.includes('must it definitely do'), null, { timeout: 10000 }).catch(() => {});
check('skip advances', (await page.textContent('#questionText')).includes('must it definitely do'));
await page.click('#planNowBtn');
await page.waitForSelector('#tasksBody tr', { timeout: 10000 }).catch(() => {});
const rows = await page.$$('#tasksBody tr');
check('plan renders task rows', rows.length >= 4, rows.length + ' rows');
const tableText = await page.textContent('#tasksBody');
check('model names present (Spark, Wonder, You)', /Spark/.test(tableText) && /Wonder/.test(tableText) && /You/.test(tableText));
check('waits-for column present', (await page.textContent('table thead')).includes('Waits for'));
check('goals render', (await page.$$('#goalsBox .goal')).length === 3);
check('project link shown', (await page.textContent('#linkText')).includes('?pid=zuck-'));

// run without key -> needs_key, no fake done
await page.click('#runBtn');
await page.waitForFunction(() => document.getElementById('tasksBody').textContent.includes('Needs your Meta key'), null, { timeout: 10000 }).catch(() => {});
const badges = await page.$$eval('#tasksBody .badge', (ns) => ns.map((n) => n.textContent));
check('run without key waits, nothing done', badges.includes('Needs your Meta key') && !badges.includes('done'), badges.join(','));

// refresh visible effect
await page.click('#refreshBtn');
await page.waitForFunction(() => document.getElementById('planOk').textContent.includes('Refreshed just now'), null, { timeout: 10000 }).catch(() => {});
check('refresh has visible effect', (await page.textContent('#planOk')).includes('Refreshed just now'));

// widths
for (const w of [390, 1280]) {
  await page.setViewportSize({ width: w, height: 900 });
  await page.waitForTimeout(400);
  const sw = await page.evaluate(() => document.documentElement.scrollWidth);
  check(w + 'px no horizontal overflow', sw <= w + 1, String(sw));
}
check('zero page errors', errors.length === 0, errors.join(' | ') || '');
await browser.close();

// ---- save/exit via seeded test session (server-side, test state only) ----
const sid = 's-testseed1';
writeFileSync('/home/hatch/workspace/handoff-lol/zuck_sessions_test.json', JSON.stringify({ [sid]: { user: 'tester', ts: new Date().toISOString() } }));
const base = 'http://127.0.0.1:8105/zuck';
let r = await fetch(base + '/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ request: 'seeded saved project', sid }) }).then((x) => x.json());
const pid2 = r.project.id;
await fetch(base + '/plan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pid: pid2, sid }) });
const browser2 = await chromium.launch({ args: ['--no-sandbox'] });
const page2 = await (await browser2.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
await page2.goto(URL + '?sid=' + sid, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page2.waitForFunction(() => document.getElementById('authArea').textContent.includes('@tester'), null, { timeout: 10000 }).catch(() => {});
check('session restore shows signed-in user', (await page2.textContent('#authArea')).includes('@tester'));
await page2.waitForFunction(() => document.getElementById('myList').textContent.includes('seeded saved project'), null, { timeout: 10000 }).catch(() => {});
check('my projects lists saved project', (await page2.textContent('#myList')).includes('seeded saved project'));
await page2.locator('#myList button').first().click();
await page2.waitForSelector('#tasksBody tr', { timeout: 10000 }).catch(() => {});
check('opening saved project renders its plan', (await page2.$$('#tasksBody tr')).length >= 4);
check('saved indicator shown', (await page2.textContent('#progText')).includes('Saved to your account'));
// session-start rejects a bad token (negative path, live code)
const bad = await fetch(base + '/session-start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'nope' }) }).then((x) => x.json());
check('session-start rejects a bad token', bad.ok === false);
// sign out returns to fresh start
await page2.locator('#authArea button').click();
await page2.waitForTimeout(800);
check('sign out returns to start panel', !(await page2.$eval('#startPanel', (n) => n.classList.contains('hidden'))));
await browser2.close();

// ---- socnet saved-key path (dummy server key: proves the path engages) ----
const socSid = 's-socnet1';
const sessRaw = JSON.parse((await import('node:fs')).readFileSync('/home/hatch/workspace/handoff-lol/zuck_sessions_test.json', 'utf8'));
sessRaw[socSid] = { user: 'socnet', ts: new Date().toISOString() };
(await import('node:fs')).writeFileSync('/home/hatch/workspace/handoff-lol/zuck_sessions_test.json', JSON.stringify(sessRaw));
let rs = await fetch(base + '/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ request: 'socnet saved-key probe', sid: socSid }) }).then((x) => x.json());
await fetch(base + '/plan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pid: rs.project.id, sid: socSid }) });
const browser3 = await chromium.launch({ args: ['--no-sandbox'] });
const page3 = await (await browser3.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
await page3.goto(URL + '?sid=' + socSid, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page3.waitForFunction(() => document.getElementById('authArea').textContent.includes('@socnet'), null, { timeout: 10000 }).catch(() => {});
check('socnet session restores', (await page3.textContent('#authArea')).includes('@socnet'));
await page3.locator('#myList button').first().click();
await page3.waitForSelector('#tasksBody tr', { timeout: 10000 }).catch(() => {});
check('socnet key hint shown', (await page3.$eval('#keyInput', (n) => n.placeholder)).includes('Your saved Meta key applies'));
await page3.click('#runBtn');
await page3.waitForFunction(() => document.getElementById('tasksBody').textContent.includes('error'), null, { timeout: 60000 }).catch(() => {});
const socBadges = await page3.$$eval('#tasksBody .badge', (ns) => ns.map((n) => n.textContent));
check('socnet run uses server key (bad dummy key errors, never waits)', socBadges.includes('error') && !socBadges.includes('Needs your Meta key'), socBadges.join(','));
await browser3.close();

console.log(fail === 0 ? 'AUDIT ALL PASS (' + pass + ' checks)' : 'AUDIT FAILURES: ' + fail + ' of ' + (pass + fail));
process.exit(fail === 0 ? 0 : 1);
