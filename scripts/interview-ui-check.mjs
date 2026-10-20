// End-to-end smoke test for the interview UI (Frontend/src/Interview.jsx).
//
// Drives the built frontend through Chrome DevTools Protocol:
//   interviewer creates -> configures -> starts -> ends -> loads report
//   candidate joins via the invite link and sees the problem / submit button
//
// Usage: node scripts/interview-ui-check.mjs
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import WebSocket from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const PORT = 5004;
const CDP_PORT = 9333;
const BASE = `http://127.0.0.1:${PORT}`;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const USER_DIR = fs.mkdtempSync('/tmp/iv-ui-chrome-');

const results = [];
const rec = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ::  ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let backend = null;
let chrome = null;
let browserConn = null;
// Uncaught exceptions seen inside the browser pages.
const pageErrors = [];
const consoleErrors = [];
const openTargets = [];

function startBackend() {
  const fd = fs.openSync('/tmp/iv-ui-server.log', 'w');
  backend = spawn(process.execPath, [path.join(root, 'Backend', 'index.js')], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(PORT),
      INTERVIEW_ALLOW_SHORT: '1',
      INTERVIEW_SUBMIT_COOLDOWN_MS: '300',
      INTERVIEW_MAX_SUBMISSIONS: '6',
      // The report is polled while the final auto judge runs.
      REPLAY_RATE_MAX: '500',
    },
    stdio: ['ignore', fd, fd],
  });
}

function startChrome() {
  chrome = spawn(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${USER_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--no-sandbox',
    '--window-size=1440,900',
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'ignore'] });
}

async function waitForServer(url, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { await fetch(url + '/'); return; } catch { await sleep(200); }
  }
  throw new Error(`server ${url} not up in ${ms}ms`);
}

async function waitForCdp(ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error(`chrome devtools not up in ${ms}ms`);
}

// Minimal CDP client for a single page target.
class Target {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = null;
    ws.on('close', (code, reason) => {
      this.closed = `closed(${code} ${String(reason)})`;
      for (const [, p] of this.pending) p.reject(new Error(`cdp ws ${this.closed}`));
      this.pending.clear();
    });
    ws.on('error', (e) => { this.closed = `error(${e.message})`; });
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      // Uncaught exceptions in the page (React render errors, socket handler
      // errors) are collected and reported at the end.
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params?.exceptionDetails;
        pageErrors.push(d?.exception?.description || d?.text || 'unknown exception');
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
        const args = (msg.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
        consoleErrors.push(args.slice(0, 300));
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message}`));
        else resolve(msg.result);
      }
    });
  }

  static async attach(url, enableDomains = true) {
    const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
    await new Promise((res, rej) => {
      ws.once('open', res);
      ws.once('error', rej);
    });
    const t = new Target(ws);
    if (enableDomains) {
      await t.send('Page.enable');
      await t.send('Runtime.enable');
    }
    return t;
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`cdp timeout: ${method}${this.closed ? ` (${this.closed})` : ''}`));
        }
      }, 30000);
    });
  }

  async goto(url) {
    await this.send('Page.navigate', { url });
    await sleep(1200);
  }

  // Run JS in the page and return its JSON-serialised value.
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error(`page error: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
    }
    return r.result?.value;
  }

  async waitFor(expression, ms = 15000, label = 'condition') {
    const t0 = Date.now();
    let last = null;
    while (Date.now() - t0 < ms) {
      try {
        last = await this.eval(expression);
        if (last) return last;
      } catch (e) {
        last = e.message;
      }
      await sleep(200);
    }
    throw new Error(`timeout waiting for ${label} (last=${JSON.stringify(last)})`);
  }

  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

async function newPage(incognito = false) {
  let info;
  if (incognito) {
    // A separate browser context, so the "candidate" does not share the
    // interviewer's localStorage (the interviewer key would otherwise turn
    // the candidate page into an interviewer takeover).
    const { browserContextId } = await browserConn.send('Target.createBrowserContext');
    const { targetId } = await browserConn.send('Target.createTarget', { url: 'about:blank', browserContextId });
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    info = list.find((x) => x.id === targetId);
    if (!info) throw new Error('incognito target not found');
  } else {
    const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' });
    info = await r.json();
  }
  const t = await Target.attach(info.webSocketDebuggerUrl);
  openTargets.push(t);
  return t;
}

// Browser-level connection (needed to create isolated contexts).
async function connectBrowser() {
  const v = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
  browserConn = await Target.attach(v.webSocketDebuggerUrl, false);
}


// ---- Page-side helpers (React controlled inputs need the native setter) ----
const SET_VALUE = (selector, value) => {
  const el = document.querySelector(selector);
  if (!el) return `missing ${selector}`;
  const proto = el.tagName === 'SELECT'
    ? window.HTMLSelectElement.prototype
    : (el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype);
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
};
const CLICK_TEXT = (selector, text) => {
  const el = [...document.querySelectorAll(selector)].find((n) => n.textContent.trim() === text);
  if (!el) return `no ${selector} with text "${text}"`;
  el.click();
  return true;
};
const TEXT = (selector) => (document.querySelector(selector) || {}).textContent || '';
const COUNT = (selector) => document.querySelectorAll(selector).length;
const OPTIONS = (selector, index) => {
  const s = document.querySelectorAll(selector)[index || 0];
  return s ? s.options.length : 0;
};
// The setup form has a name input and (for candidates) a room-id input, so
// address them by placeholder instead of by position.
const SET_PLACEHOLDER = (ph, value) => {
  const el = [...document.querySelectorAll('input')].find((n) => n.placeholder === ph);
  if (!el) return `no input with placeholder "${ph}"`;
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
};
const VALUE_OF_PLACEHOLDER = (ph) => {
  const el = [...document.querySelectorAll('input')].find((n) => n.placeholder === ph);
  return el ? el.value : null;
};

async function testSetupScreen() {
  const t = await newPage();
  try {
    await t.goto(`${BASE}/?interview=1`);
    await t.waitFor(`document.body && document.body.innerText.includes('Interview Mode')`, 15000, 'setup screen');
    const hasTabs = await t.eval(`document.body.innerText.includes('Interviewer') && document.body.innerText.includes('Candidate')`);
    if (!hasTabs) throw new Error('role tabs missing');
    const back = await t.eval(`document.body.innerText.includes('Back to collaboration')`);
    if (!back) throw new Error('back link missing');
    rec('ui-setup-screen', true, 'role tabs + back link rendered');
  } finally {
    t.close();
  }
}

async function runInterviewerFlow() {
  const t = await newPage();
  await t.goto(`${BASE}/?interview=1`);
  await t.waitFor(`document.body && document.body.innerText.includes('Interview Mode')`, 15000, 'setup screen');

  const setName = await t.eval(`(${SET_PLACEHOLDER})('Your name', 'IntA')`);
  if (setName !== true) throw new Error(String(setName));
  const clicked = await t.eval(`(${CLICK_TEXT})('.interview-setup .join-form button', 'Create interview')`);
  if (clicked !== true) throw new Error(String(clicked));

  await t.waitFor(`!!document.querySelector('.interview-sidebar')`, 15000, 'room screen');
  const heading = await t.eval(`(${TEXT})('.room-info h2')`);
  if (!/^Interview [a-z0-9]{8}$/.test(heading.trim())) throw new Error(`bad heading "${heading}"`);

  // The interviewer sees the problem bank as soon as the state arrives.
  // (.iv-panel .iv-field select [0] is the problem picker, not duration/language)
  const bankSize = await t.waitFor(
    `(${OPTIONS})('.iv-panel .iv-field select') > 1 ? (${OPTIONS})('.iv-panel .iv-field select') : 0`,
    15000, 'problem bank');
  if (bankSize !== 5) throw new Error(`problem bank has ${bankSize} options, expected 5 (4 problems + placeholder)`);

  const startDisabled = await t.eval(`document.querySelector('.iv-start').disabled`);
  if (!startDisabled) throw new Error('start button should be disabled before a problem is picked');

  const picked = await t.eval(`(${SET_VALUE})('.iv-panel .iv-field select', 'two-sum')`);
  if (picked !== true) throw new Error(String(picked));

  await t.waitFor(`(${TEXT})('.iv-problem h3').includes('Two Sum')`, 15000, 'problem statement');
  const statement = await t.eval(`(${TEXT})('.iv-statement')`);
  if (!statement.includes('Input format')) throw new Error('problem statement missing body');

  // The interviewer page must never receive the hidden tests.
  const leaked = await t.eval(`document.body.innerHTML.includes('2 7 11 13 1')`);
  if (leaked) throw new Error('hidden test input leaked to the interviewer page');

  const started = await t.eval(`(${CLICK_TEXT})('button', 'Start interview')`);
  if (started !== true) throw new Error(String(started));

  await t.waitFor(`!!document.querySelector('.iv-badge.status-running')`, 15000, 'running status');
  const timer = await t.waitFor(
    `(/^\\d\\d:\\d\\d$/.test((${TEXT})('.iv-timer').trim()) ? 1 : 0)`, 15000, 'timer');
  if (!timer) throw new Error('timer did not render as mm:ss');

  // The interviewer watches the code and never edits it.
  const langDisabled = await t.eval(`document.querySelector('.iv-field select.language-selector').disabled`);
  if (!langDisabled) throw new Error('interviewer language selector should be read-only');
  const hasEditor = await t.waitFor(`!!document.querySelector('.editor-wrapper .monaco-editor')`, 15000, 'editor');
  if (!hasEditor) throw new Error('monaco editor missing');

  return { t, roomId: heading.trim().replace('Interview ', '') };
}

async function runCandidateFlow(roomId) {
  const t = await newPage();
  await t.goto(`${BASE}/?interview=1&room=${roomId}&role=candidate`);
  // This page shares the browser profile with the interviewer page, so clear
  // the stored keys first: otherwise the invitee would pick up the interviewer
  // key and take the interviewer role over instead of joining as candidate.
  await t.eval(`localStorage.clear(); true`);
  await t.waitFor(`document.body && document.body.innerText.includes('Interview Mode')`, 15000, 'setup screen');

  // The invite link pre-fills the room id and selects the candidate tab.
  const prefilled = await t.eval(`(${VALUE_OF_PLACEHOLDER})('Room ID')`);
  if (prefilled !== roomId) throw new Error(`room id not prefilled: "${prefilled}"`);

  const setName = await t.eval(`(${SET_PLACEHOLDER})('Your name', 'CandA')`);
  if (setName !== true) throw new Error(String(setName));
  const clicked = await t.eval(`(${CLICK_TEXT})('.interview-setup .join-form button', 'Join interview')`);
  if (clicked !== true) throw new Error(String(clicked));

  await t.waitFor(`!!document.querySelector('.interview-sidebar')`, 20000, 'room screen');
  await t.waitFor(`!!document.querySelector('.iv-badge') && document.body.innerText.includes('Candidate')`, 10000, 'candidate badge');

  const title = await t.waitFor(`(${TEXT})('.iv-problem h3') || 0`, 15000, 'problem title');
  if (!String(title).includes('Two Sum')) throw new Error(`candidate problem title "${title}"`);

  const submitText = await t.waitFor(`document.querySelector('.iv-submit') && document.querySelector('.iv-submit').textContent || 0`, 15000, 'submit button');
  if (!String(submitText).includes('Submit solution')) throw new Error(`submit button text "${submitText}"`);
  const submitDisabled = await t.eval(`document.querySelector('.iv-submit').disabled`);
  if (submitDisabled) throw new Error('submit button disabled while running');

  // The candidate owns the language selector; the interviewer does not.
  const langEnabled = await t.eval(`!document.querySelector('.iv-field select.language-selector').disabled`);
  if (!langEnabled) throw new Error('candidate language selector should be enabled');

  // The candidate must never see the hidden tests.
  const leaked = await t.eval(`document.body.innerHTML.includes('2 7 11 13 1')`);
  if (leaked) throw new Error('hidden test input leaked to the candidate page');

  const twoUsers = await t.waitFor(`(${COUNT})('.sidebar ul li') === 2 ? 1 : 0`, 15000, 'two users in room');
  if (!twoUsers) throw new Error('expected 2 users in the room list');

  // Monaco loads its bundle lazily; the candidate page is a cold context.
  let editorPresent = null;
  try {
    editorPresent = await t.waitFor(
      `!!document.querySelector('.monaco-editor textarea.inputarea')`, 45000, 'candidate editor');
  } catch (e) {
    const wrapper = await t.eval(
      `(() => { const w = document.querySelector('.editor-wrapper'); return w ? w.innerHTML.slice(0, 400) : 'no .editor-wrapper'; })()`);
    throw new Error(`${e.message} :: wrapper=${wrapper}`);
  }
  if (!editorPresent) throw new Error('candidate editor missing');

  // Submit the current editor content and wait for the judge's verdict to
  // come back and be rendered (the seed code cannot solve the problem, so a
  // non-AC verdict is expected).
  const clickedSubmit = await t.eval(`(${CLICK_TEXT})('button', 'Submit solution')`);
  if (clickedSubmit !== true) throw new Error(String(clickedSubmit));
  await t.waitFor(`!!document.querySelector('.iv-result')`, 120000, 'submission result');
  const submitVerdict = await t.eval(`(${TEXT})('.iv-result .iv-verdict')`);
  if (!submitVerdict) throw new Error('no verdict rendered for the submission');
  return { t, submitVerdict };
}

async function runEndAndReport(iv) {
  const ended = await iv.eval(`(${CLICK_TEXT})('button', 'End interview')`);
  if (ended !== true) throw new Error(String(ended));
  await iv.waitFor(`!!document.querySelector('.iv-badge.status-ended')`, 20000, 'ended status');
  await iv.waitFor(`document.body.innerText.includes('Report')`, 20000, 'report panel');
  const loaded = await iv.eval(`(${CLICK_TEXT})('button', 'Load report')`);
  if (loaded !== true) throw new Error(String(loaded));
  // The final auto judge runs 5 Wandbox round-trips AFTER the interview has
  // already been reported as ended, so keep reloading the report until the
  // final submission is included.
  await iv.waitFor(`!!document.querySelector('.iv-report')`, 180000, 'report body');
  const verdict = await iv.eval(`(async () => {
    const t0 = Date.now();
    let v = '';
    while (Date.now() - t0 < 180000) {
      const el = document.querySelector('.iv-report .iv-verdict');
      if (el && el.textContent.trim()) { v = el.textContent.trim(); break; }
      [...document.querySelectorAll('button')]
        .filter((b) => b.textContent.trim() === 'Load report')
        .forEach((b) => b.click());
      await new Promise((r) => setTimeout(r, 2000));
    }
    return v;
  })()`);
  if (!verdict) throw new Error('report has no final verdict');
  const replayLink = await iv.eval(`!!document.querySelector('.iv-report a')`);
  if (!replayLink) throw new Error('report missing replay link');
  return verdict;
}


async function main() {
  startBackend();
  startChrome();
  await waitForServer(BASE);
  await waitForCdp();
  await connectBrowser();

  let iv = null;
  let cand = null;
  let roomId = null;

  try {
    await testSetupScreen();
  } catch (e) {
    rec('ui-setup-screen', false, e.message);
  }

  try {
    const flow = await runInterviewerFlow();
    iv = flow.t;
    roomId = flow.roomId;
    rec('ui-interviewer-flow', true, `room=${roomId}, bank=4 problems, statement + timer + read-only editor ok`);
  } catch (e) {
    rec('ui-interviewer-flow', false, e.message);
  }

  if (roomId) {
    try {
      const c = await runCandidateFlow(roomId);
      cand = c.t;
      rec('ui-candidate-flow', true, `joined via the invite link, saw the problem + an enabled submit button, submit -> ${c.submitVerdict}`);
    } catch (e) {
      rec('ui-candidate-flow', false, e.message);
    }
  }

  if (iv) {
    try {
      const verdict = await runEndAndReport(iv);
      rec('ui-end-report', true, `final verdict=${verdict}, replay link present`);
    } catch (e) {
      rec('ui-end-report', false, e.message);
    }
  }

  if (cand) {
    try {
      await cand.waitFor(`!!document.querySelector('.iv-badge.status-ended')`, 60000, 'candidate sees ended');
      const disabled = await cand.eval(`document.querySelector('.iv-submit') ? document.querySelector('.iv-submit').disabled : true`);
      if (!disabled) throw new Error('submit still enabled after the interview ended');
      const btnText = await cand.eval(`document.querySelector('.iv-submit').textContent`);
      rec('ui-candidate-ended', true, `ended state visible, submit disabled ("${btnText}")`);
    } catch (e) {
      rec('ui-candidate-ended', false, e.message);
    }
  }
}

let exitCode = 0;
main()
  .catch((e) => { console.error('FATAL', e); exitCode = 2; })
  .finally(() => {
    const passed = results.filter((r) => r.pass).length;
    console.log(`\n=== ${passed}/${results.length} passed ===`);
    // Filter out benign noise (favicon misses etc. are network errors, not
    // uncaught exceptions, so anything here really is a page bug).
    if (pageErrors.length) {
      console.log('uncaught page errors:');
      for (const e of [...new Set(pageErrors)]) console.log('  ' + e.split('\n')[0]);
      exitCode = exitCode || 3;
    } else {
      console.log('no uncaught page errors');
    }
    if (consoleErrors.length) {
      console.log('console errors:');
      for (const e of [...new Set(consoleErrors)]) console.log('  ' + e);
    }
    for (const t of openTargets) t.close();
    try { if (chrome) chrome.kill('SIGKILL'); } catch { /* ignore */ }
    try { if (backend) backend.kill('SIGKILL'); } catch { /* ignore */ }
    setTimeout(() => process.exit(exitCode || (passed === results.length ? 0 : 1)), 200);
  });

setTimeout(() => {
  console.error('GLOBAL 600s FORCE EXIT');
  try { if (chrome) chrome.kill('SIGKILL'); } catch { /* ignore */ }
  try { if (backend) backend.kill('SIGKILL'); } catch { /* ignore */ }
  process.exit(9);
}, 600000);

