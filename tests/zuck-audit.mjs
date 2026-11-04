// Zuck interaction audit against the throwaway test server (127.0.0.1:8105)
// and the served test page (127.0.0.1:8104). Every control must show a
// visible effect; gates must hold; no fake completions without a key.
// Save/exit is tested with a seeded test session (test state only): the
// OAuth code exchange itself is cricket-identical code and is currently
// platform-blocked at the authorize step (proven live on Cricket).
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
check('cartoon present (no beast)', (await page.$('#zuckSvg')) !== null && (await page.$('#beastSvg')) === null);
check('sign-in button present', (await page.textContent('#authArea')).includes('Sign in with handoff'));

// empty request blocked visibly
await page.click('#startBtn');
await page.waitForTimeout(500);
check('empty request blocked visibly', (await page.textContent('#bubble')).includes('Tell Zuck what you want built first'));

// start -> QA
await page.fill('#requestInput', 'a VR gallery where visitors walk through rooms of AI art');
await page.click('#startBtn');
await page.waitForSelector('#qaPanel:not(.hidden)', { timeout: 10000 }).catch(() => {});
check('start shows first question', (await page.textContent('#questionText')).includes('Who is this for'));

// answer + skip + just plan it
await page.fill('#answerInput', 'people who like art');
await page.click('#answerBtn');
await page.waitForFunction(() => document.getElementById('questionText').textContent.includes('Where does it live'), null, { timeout: 10000 }).catch(() => {});
check('answer advances', (await page.textContent('#questionText')).includes('Where does it live'));
await page.click('#skipBtn');
await page.waitForFunction(() => document.getElementById('questionText').textContent.includes('must it definitely do'), null, { timeout: 10000 }).catch(() => {});
check('skip advances', (await page.textContent('#questionText')).includes('must it definitely do'));
await page.click('#planNowBtn');
await page.waitForSelector('#tasksBox .card', { timeout: 10000 }).catch(() => {});
const cards = await page.$$('#tasksBox .card');
check('plan renders task cards', cards.length >= 4, cards.length + ' cards');
const cardsText = await page.textContent('#tasksBox');
check('model badges present (Spark, Wonder, You)', /Spark/.test(cardsText) && /Wonder/.test(cardsText) && /You/.test(cardsText));
check('gate note present (waits for)', /waits for/.test(cardsText));
check('project link shown', (await page.textContent('#linkText')).includes('?pid=zuck-'));

// run without key -> needs_key, no fake done
await page.click('#runBtn');
await page.waitForFunction(() => document.getElementById('tasksBox').textContent.includes('Needs your Meta key'), null, { timeout: 10000 }).catch(() => {});
const afterRun = await page.textContent('#tasksBox');
check('run without key shows needs_key, no fake done', /Needs your Meta key/.test(afterRun) && !/status: done/.test(afterRun));

// refresh visible effect
await page.click('#refreshBtn');
await page.waitForFunction(() => document.getElementById('bubble').textContent.includes('Refreshed just now'), null, { timeout: 10000 }).catch(() => {});
check('refresh has visible effect', (await page.textContent('#bubble')).includes('Refreshed just now'));

// pupils follow (cartoon eyes)
const cxBefore = await page.getAttribute('#pupilL', 'cx');
await page.mouse.move(1200, 200);
await page.waitForTimeout(400);
const cxAfter = await page.getAttribute('#pupilL', 'cx');
check('cartoon pupils follow cursor', parseFloat(cxAfter) > parseFloat(cxBefore), cxBefore + ' -> ' + cxAfter);

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
// create an owned project via the test server API
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
await page2.waitForSelector('#tasksBox .card', { timeout: 10000 }).catch(() => {});
check('opening saved project renders its plan', (await page2.$$('#tasksBox .card')).length >= 4);
check('saved indicator shown', (await page2.textContent('#statusText')).includes('Saved to your account'));
// sign out returns to fresh start
await page2.locator('#authArea button').click();
await page2.waitForTimeout(800);
check('sign out returns to start panel', !(await page2.$eval('#startPanel', (n) => n.classList.contains('hidden'))));
await browser2.close();

console.log(fail === 0 ? 'AUDIT ALL PASS (' + pass + ' checks)' : 'AUDIT FAILURES: ' + fail + ' of ' + (pass + fail));
process.exit(fail === 0 ? 0 : 1);
