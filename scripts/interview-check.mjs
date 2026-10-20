import { createRequire } from 'module';
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const req = createRequire(path.join(root, 'Frontend', 'package.json'));
const ioMod = req('socket.io-client');
const io = ioMod.io || ioMod.default || ioMod;
const Y = req('yjs');
const { PROBLEMS } = await import(path.join(root, 'Backend', 'problems.js'));

const PORT = 5002;
const BASE = `http://localhost:${PORT}`;
const LOG = '/tmp/interview-server.log';

const results = [];
const rec = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ::  ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let backend = null;
function startBackend() {
  const fd = fs.openSync(LOG, 'w');
  backend = spawn(process.execPath, [path.join(root, 'Backend', 'index.js')], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(PORT),
      INTERVIEW_ALLOW_SHORT: '1',
      INTERVIEW_SUBMIT_COOLDOWN_MS: '300',
      INTERVIEW_GRACE_MS: '1500',
      INTERVIEW_MAX_SUBMISSIONS: '6',
      REPLAY_RATE_MAX: '1000',
    },
    stdio: ['ignore', fd, fd],
  });
}
function killBackend() {
  if (backend && backend.exitCode === null) {
    try { backend.kill('SIGKILL'); } catch { /* already dead */ }
  }
}
async function waitForServer(url, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { await fetch(url + '/'); return; } catch { await sleep(200); }
  }
  throw new Error(`server ${url} not up in ${ms}ms`);
}

function connect() {
  const s = io(BASE, { transports: ['websocket'], forceNew: true });
  // Persistent collector: "interview-state" can arrive BEFORE or AFTER the ack
  // resolves, so a listener attached at await-time can miss it. Collect from
  // the moment the socket is created and inspect the history afterwards.
  s.__states = [];
  s.on('interview-state', (p) => s.__states.push(p));
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('connect timeout')), 8000);
    s.once('connect', () => { clearTimeout(t); res(s); });
    s.once('connect_error', (e) => { clearTimeout(t); rej(e); });
  });
}
// Last interview-state seen on this socket (undefined if none yet).
function lastState(sock) {
  return sock.__states && sock.__states.length ? sock.__states[sock.__states.length - 1] : undefined;
}
// Wait until a matching interview-state has been collected.
function waitState(sock, pred, ms = 8000) {
  const t0 = Date.now();
  return new Promise((res, rej) => {
    const check = () => {
      const hit = (sock.__states || []).find((s) => (pred ? pred(s) : true));
      if (hit) return res(hit);
      if (Date.now() - t0 > ms) return rej(new Error('timeout waiting interview-state'));
      return setTimeout(check, 100);
    };
    check();
  });
}
function ackOf(socket, event, payload, ms = 8000) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`ack timeout for ${event}`)), ms);
    socket.emit(event, payload, (r) => { clearTimeout(t); res(r); });
  });
}
function waitFor(socket, event, ms = 8000, filter = null) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => { socket.off(event, h); rej(new Error(`timeout waiting ${event}`)); }, ms);
    const h = (payload) => {
      if (filter && !filter(payload)) return;
      clearTimeout(t); socket.off(event, h); res(payload);
    };
    socket.on(event, h);
  });
}
function collect(socket, event) {
  const arr = [];
  socket.on(event, (p) => arr.push(p));
  return arr;
}
// Same handshake logic as Frontend/src/yjsProvider.js.
// IMPORTANT: attach BEFORE joining, otherwise the "yjs-init" event (sent
// during the join) is missed and the local doc starts out of sync with the
// server (empty, wrong clock) -> every later update is dropped as a gap.
function attachDoc(socket) {
  const doc = new Y.Doc();
  socket.on('yjs-init', ({ doc: d }) => Y.applyUpdate(doc, new Uint8Array(d)));
  socket.on('yjs-update', (data) => Y.applyUpdate(doc, new Uint8Array(data), 'remote'));
  doc.on('update', (u, origin) => { if (origin !== 'remote') socket.emit('yjs-update', u); });
  return doc;
}
function setDocText(doc, text) {
  const t = doc.getText('monaco');
  doc.transact(() => { t.delete(0, t.length); t.insert(0, text); });
}
const withTimeout = (p, ms, label) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms);
  p.then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); });
});
// ---------- (a) reference validation ----------
async function testA() {
  const py = spawnSync('python3', ['--version'], { encoding: 'utf8' });
  if (py.status !== 0) {
    rec('a-reference-validation', false, 'INCONCLUSIVE: python3 not available');
    return;
  }
  const norm = (s) => {
    const L = String(s).split('\n').map((l) => l.replace(/\s+$/, ''));
    while (L.length && L[0] === '') L.shift();
    while (L.length && L[L.length - 1] === '') L.pop();
    return L.join('\n');
  };
  const lines = [];
  let allOk = true;
  for (const p of PROBLEMS) {
    let ok = 0; let bad = 0;
    const cases = [
      ...p.samples.map((s, i) => ({ ...s, kind: 'sample', i })),
      ...p.tests.map((t, i) => ({ ...t, kind: 'hidden', i })),
    ];
    for (const c of cases) {
      const r = spawnSync('python3', ['-c', p.referenceSolution], { input: c.input, encoding: 'utf8', timeout: 10000 });
      if (r.status !== 0) { bad++; allOk = false; lines.push(`${p.id}/${c.kind}#${c.i} python-exit=${r.status}`); continue; }
      if (norm(r.stdout || '') !== norm(c.output)) {
        bad++; allOk = false;
        lines.push(`${p.id}/${c.kind}#${c.i} got=${JSON.stringify(norm(r.stdout || ''))} want=${JSON.stringify(norm(c.output))}`);
        continue;
      }
      ok++;
    }
    lines.push(`${p.id}:${ok}ok/${bad}bad`);
  }
  rec('a-reference-validation', allOk, lines.join(' | '));
}

// Hidden values that are NOT also published as samples. A hidden output like
// "true" or "3" is legitimately identical to a public sample output, so only
// values exclusive to the hidden set can prove a leak.
function hiddenOnly(problem) {
  const sampleIns = new Set(problem.samples.map((s) => s.input.trim()));
  const sampleOuts = new Set(problem.samples.map((s) => s.output.trim()));
  return {
    inputs: problem.tests.map((t) => t.input).filter((i) => !sampleIns.has(i.trim())),
    outputs: problem.tests.map((t) => t.output).filter((o) => !sampleOuts.has(o.trim())),
  };
}

// Assert a JSON blob does not contain any hidden-only value.
// Matching uses the JSON-ESCAPED form (e.g. "a" -> "\"a\""), otherwise a
// 1-character hidden value would match any prose that happens to contain it
// (e.g. the letter "a" inside a problem statement).
function assertNoLeak(json, label) {
  for (const p of PROBLEMS) {
    const h = hiddenOnly(p);
    for (const i of h.inputs) {
      if (i && json.includes(JSON.stringify(i))) throw new Error(`${label}: LEAK hidden input of ${p.id}: ${JSON.stringify(i)}`);
    }
    for (const o of h.outputs) {
      if (o && json.includes(JSON.stringify(o))) throw new Error(`${label}: LEAK hidden output of ${p.id}: ${JSON.stringify(o)}`);
    }
  }
  if (json.includes('referenceSolution')) throw new Error(`${label}: LEAK referenceSolution`);
}

// ---------- (b) create-interview ----------
async function testB() {
  const ivSock = await connect();
  const ack = await ackOf(ivSock, 'create-interview', { userName: 'Interviewer' });
  if (!ack || !ack.ok) throw new Error(`create-interview failed: ${JSON.stringify(ack)}`);
  const state = await waitState(ivSock, (s) => s.role === 'interviewer', 8000);
  if (state.role !== 'interviewer') throw new Error(`role=${state.role}`);
  if (state.status !== 'lobby') throw new Error(`status=${state.status}`);
  if (!/^[a-z0-9]{8}$/.test(ack.roomId)) throw new Error(`roomId="${ack.roomId}" not 8 lowercase alnum`);
  if (typeof ack.interviewerKey !== 'string' || ack.interviewerKey.length < 20) throw new Error('interviewerKey missing/short');
  if (!Array.isArray(state.problemBank) || state.problemBank.length !== 4) {
    throw new Error(`problemBank length=${state.problemBank?.length}`);
  }
  const json = JSON.stringify(state);
  assertNoLeak(json, 'interview-state');
  const bankKeys = new Set(state.problemBank.flatMap((p) => Object.keys(p)));
  for (const k of bankKeys) if (k === 'tests' || k === 'referenceSolution') throw new Error(`problemBank leaks ${k}`);
  return { roomId: ack.roomId, interviewerKey: ack.interviewerKey, ivSock };
}

// ---------- (c) join-interview ----------
async function testC(ctx) {
  const { roomId, interviewerKey } = ctx;
  const notes = [];

  // unknown room
  const s1 = await connect();
  const a1 = await ackOf(s1, 'join-interview', { roomId: 'nosuchroom', userName: 'X' });
  if (a1.ok !== false) throw new Error('unknown room was accepted');
  notes.push(`unknown room -> "${a1.error}"`);
  s1.disconnect();

  // normal (non-interview) room id
  const n1 = await connect();
  await new Promise((r) => { n1.emit('join', { roomId: 'normalroom1', userName: 'N' }); setTimeout(r, 400); });
  const a2 = await ackOf(n1, 'join-interview', { roomId: 'normalroom1', userName: 'X' });
  if (a2.ok !== false) throw new Error('normal room was accepted as interview');
  notes.push(`normal room -> "${a2.error}"`);
  n1.disconnect();

  // candidate joins
  const c1 = await connect();
  const a3 = await ackOf(c1, 'join-interview', { roomId, userName: 'Candidate' });
  if (!a3.ok || a3.role !== 'candidate') throw new Error(`candidate join failed: ${JSON.stringify(a3)}`);
  if (typeof a3.candidateKey !== 'string' || a3.candidateKey.length < 20) throw new Error('candidateKey missing');
  const candKey = a3.candidateKey;
  const cState = await waitState(c1, (s) => s.role === 'candidate', 8000);
  if (cState.role !== 'candidate') throw new Error(`candidate role=${cState.role}`);
  notes.push(`candidate joined, key len=${candKey.length}`);

  // second, different candidate -> rejected
  const c2 = await connect();
  const a4 = await ackOf(c2, 'join-interview', { roomId, userName: 'Candidate2' });
  if (a4.ok !== false) throw new Error('second candidate was accepted');
  notes.push(`2nd candidate -> "${a4.error}"`);
  c2.disconnect();

  // candidate reconnect with candidateKey -> accepted
  const c3 = await connect();
  const a5 = await ackOf(c3, 'join-interview', { roomId, userName: 'Candidate', candidateKey: candKey });
  if (!a5.ok || a5.role !== 'candidate') throw new Error(`candidate reconnect failed: ${JSON.stringify(a5)}`);
  notes.push('candidate reconnect with key -> accepted');
  c3.disconnect();
  c1.disconnect();

  // interviewer reconnect with interviewerKey -> interviewer
  const i2 = await connect();
  const a6 = await ackOf(i2, 'join-interview', { roomId, userName: 'Interviewer', interviewerKey });
  if (!a6.ok || a6.role !== 'interviewer') throw new Error(`interviewer reconnect failed: ${JSON.stringify(a6)}`);
  notes.push('interviewer reconnect with key -> interviewer');
  i2.disconnect();

  // wrong interviewerKey must NOT grant interviewer
  const i3 = await connect();
  const a7 = await ackOf(i3, 'join-interview', { roomId, userName: 'Impostor', interviewerKey: 'wrong-key-value' });
  if (a7.ok === true && a7.role === 'interviewer') throw new Error('wrong key granted interviewer');
  notes.push(`wrong key -> ok=${a7.ok} role=${a7.role || 'none'}`);
  i3.disconnect();

  return { candKey };
}
// ---------- (d) permissions ----------
async function testD(ctx) {
  const { roomId, interviewerKey, candKey } = ctx;
  const notes = [];
  const ivSock = await connect();
  // Attach the Yjs doc BEFORE joining so "yjs-init" is received.
  const ivDoc = attachDoc(ivSock);
  const ivAck = await ackOf(ivSock, 'join-interview', { roomId, userName: 'Interviewer', interviewerKey });
  if (!ivAck.ok) throw new Error('interviewer join failed');
  const cSock = await connect();
  const cDoc = attachDoc(cSock);
  const cAck = await ackOf(cSock, 'join-interview', { roomId, userName: 'Candidate', candidateKey: candKey });
  if (!cAck.ok) throw new Error('candidate join failed');
  await sleep(700);

  // Read the CURRENT state from the persistent collector (the event may have
  // been delivered before this point, so waiting for a *new* one would hang).
  const stateOf = async (sock) => {
    const t0 = Date.now();
    while (Date.now() - t0 < 8000) {
      const st = lastState(sock);
      if (st) return st;
      await sleep(100);
    }
    throw new Error('no interview-state received');
  };

  // candidate tries configure/start/end -> ignored
  const before = await stateOf(ivSock);
  cSock.emit('interview-configure', { problemId: 'two-sum', durationMin: 30 });
  cSock.emit('interview-start');
  cSock.emit('interview-end');
  await sleep(600);
  const after = await stateOf(ivSock);
  if (after.status !== 'lobby') throw new Error(`candidate changed status to ${after.status}`);
  if (after.problem !== null) throw new Error('candidate configured a problem');
  notes.push(`candidate configure/start/end ignored (status stayed ${after.status})`);

  // interviewer start before choosing a problem -> ignored
  ivSock.emit('interview-start');
  await sleep(600);
  const afterStart = await stateOf(ivSock);
  if (afterStart.status !== 'lobby') throw new Error(`start without problem -> ${afterStart.status}`);
  notes.push('interviewer start without problem -> ignored');

  // candidate yjs-update BEFORE start -> ignored
  const ivTextBefore = ivDoc.getText('monaco').toString();
  setDocText(cDoc, 'CANDIDATE_EDIT_BEFORE_START');
  await sleep(700);
  const ivTextAfter = ivDoc.getText('monaco').toString();
  if (ivTextAfter.includes('CANDIDATE_EDIT_BEFORE_START')) {
    throw new Error('candidate edit before start was accepted');
  }
  notes.push(`candidate edit before start ignored (doc unchanged, len ${ivTextBefore.length}->${ivTextAfter.length})`);

  // interviewer configures + starts
  ivSock.emit('interview-configure', { problemId: 'two-sum', durationMin: 30 });
  await sleep(500);
  const configured = await stateOf(ivSock);
  if (!configured.problem || configured.problem.id !== 'two-sum') throw new Error('configure failed');
  if (configured.durationMs !== 30 * 60 * 1000) throw new Error(`durationMs=${configured.durationMs}`);
  ivSock.emit('interview-start');
  await sleep(600);
  const running = await stateOf(ivSock);
  if (running.status !== 'running') throw new Error(`status=${running.status}`);
  notes.push('interviewer configured two-sum/30min and started -> running');

  // candidate yjs-update AFTER start -> accepted
  setDocText(cDoc, 'CANDIDATE_EDIT_AFTER_START');
  await sleep(700);
  const ivTextAfter2 = ivDoc.getText('monaco').toString();
  if (!ivTextAfter2.includes('CANDIDATE_EDIT_AFTER_START')) {
    throw new Error('candidate edit after start was rejected');
  }
  notes.push('candidate edit after start -> accepted');

  // interviewer yjs-update anytime -> accepted (in running)
  setDocText(ivDoc, 'INTERVIEWER_EDIT');
  await sleep(700);
  const cText = cDoc.getText('monaco').toString();
  if (!cText.includes('INTERVIEWER_EDIT')) throw new Error('interviewer edit was rejected');
  notes.push('interviewer edit -> accepted');

  return { ivSock, cSock, ivDoc, cDoc };
}

// ---------- (e) confidentiality ----------
async function testE(ctx) {
  const { cSock } = ctx;
  const received = [];
  cSock.onAny((event, ...args) => {
    received.push({ event, args });
  });
  // Trigger a submission so the judging path runs while the listener is
  // attached. Wait for the result to actually arrive, otherwise the scan
  // would run before the (potentially leaky) result event is delivered.
  const resultP = waitFor(cSock, 'submission-result', 120000);
  cSock.emit('interview-submit');
  await resultP;
  await sleep(500);
  const json = JSON.stringify(received);
  assertNoLeak(json, 'candidate socket');
  const gotEvents = received.map((r) => r.event);
  if (gotEvents.includes('interview-submissions')) throw new Error('LEAK: candidate received interview-submissions');
  return { events: [...new Set(gotEvents)].join(','), bytes: json.length };
}
// ---------- (f) judging ----------
const PY_CORRECT = `import sys
data = sys.stdin.read().split()
n = int(data[0])
nums = list(map(int, data[1:1+n]))
target = int(data[1+n])
for i in range(n):
    for j in range(i+1, n):
        if nums[i] + nums[j] == target:
            print(i, j)
            sys.exit(0)
`;
const PY_WRONG = `import sys
data = sys.stdin.read().split()
n = int(data[0])
nums = list(map(int, data[1:1+n]))
target = int(data[1+n])
print(0, 1)
`;
const PY_SYNTAX = `def broken(:\n  pass\n`;
const PY_RUNTIME = `import sys\nraise ValueError("boom")\n`;

async function testF(ctx) {
  const { ivSock, cSock, ivDoc, cDoc } = ctx;
  const notes = [];
  const candResults = collect(cSock, 'submission-result');
  const ivSubs = collect(ivSock, 'interview-submissions');
  const rejects = collect(cSock, 'submission-rejected');
  cSock.emit('languageChange', { language: 'python' });
  await sleep(500);

  const submitAndWait = async (code, expect, label) => {
    const before = candResults.length;
    setDocText(cDoc, code);
    await sleep(800);
    cSock.emit('interview-submit');
    // Each submission runs 5 hidden tests SEQUENTIALLY; a Wandbox round-trip
    // takes 8-20s, so allow a generous budget.
    const t0 = Date.now();
    while (candResults.length === before && Date.now() - t0 < 240000) await sleep(300);
    if (candResults.length === before) throw new Error(`${label}: no submission-result within 240s`);
    const r = candResults[candResults.length - 1];
    if (expect && r.verdict !== expect) {
      throw new Error(`${label}: verdict=${r.verdict} expected=${expect} passed=${r.passed}/${r.total} tests=${JSON.stringify(r.tests)}`);
    }
    return r;
  };

  const ac = await submitAndWait(PY_CORRECT, 'AC', 'correct solution');
  if (ac.passed !== ac.total) throw new Error(`AC but passed=${ac.passed}/${ac.total}`);
  notes.push(`AC verdict=${ac.verdict} passed=${ac.passed}/${ac.total}`);
  const cj = JSON.stringify(ac);
  if (cj.includes('expected') || cj.includes('"input"') || cj.includes('actual')) {
    throw new Error(`candidate result leaks detail fields: ${cj}`);
  }
  notes.push('candidate result has no input/expected/actual');

  await sleep(400);
  const wa = await submitAndWait(PY_WRONG, 'WA', 'wrong solution');
  if (wa.passed >= wa.total) throw new Error(`WA but passed=${wa.passed}/${wa.total}`);
  notes.push(`WA verdict=${wa.verdict} passed=${wa.passed}/${wa.total}`);

  await sleep(400);
  const ce = await submitAndWait(PY_SYNTAX, 'CE', 'syntax error');
  notes.push(`CE verdict=${ce.verdict} passed=${ce.passed}/${ce.total} tests=${JSON.stringify(ce.tests)}`);

  await sleep(400);
  const re = await submitAndWait(PY_RUNTIME, 'RE', 'runtime error');
  notes.push(`RE verdict=${re.verdict} passed=${re.passed}/${re.total} tests=${JSON.stringify(re.tests)}`);

  if (!ivSubs.length) throw new Error('interviewer received no interview-submissions');
  // Each "interview-submissions" event carries the FULL list of submissions,
  // so take the newest list and its first entry.
  const lastList = ivSubs[ivSubs.length - 1];
  const firstSub = lastList && lastList[0];
  if (!firstSub) throw new Error('interviewer submission list is empty');
  if (!firstSub.tests || !firstSub.tests.length) throw new Error('interviewer submission has no tests');
  const td = firstSub.tests[0];
  if (!('input' in td) || !('expected' in td) || !('actual' in td)) {
    throw new Error(`interviewer test detail missing fields: ${JSON.stringify(Object.keys(td))}`);
  }
  notes.push(`interviewer detail ok input="${String(td.input).slice(0, 18)}" expected="${String(td.expected).slice(0, 18)}" actual="${String(td.actual).slice(0, 18)}"`);
  if (td.actual && td.actual.length > 500) throw new Error('actual not truncated to 500');

  const rejBefore = rejects.length;
  cSock.emit('interview-submit');
  await sleep(120);
  cSock.emit('interview-submit');
  await sleep(600);
  if (rejects.length === rejBefore) throw new Error('cooldown did not produce submission-rejected');
  const cooldownReason = rejects[rejects.length - 1].reason;
  if (!/wait/i.test(cooldownReason)) throw new Error(`unexpected rejection reason: "${cooldownReason}"`);
  notes.push(`cooldown rejected: "${cooldownReason}"`);

  // MAX_SUBMISSIONS: the env override (INTERVIEW_MAX_SUBMISSIONS) is lowered for
  // this run, so a further submit must be rejected.
  // NOTE: while a submission is still being judged the server answers with
  // "A submission is already being judged". That is a TRANSIENT rejection, not
  // the limit, so keep submitting until the limit itself is reported.
  const maxSub = Number(process.env.INTERVIEW_MAX_SUBMISSIONS || 5);
  const usedBefore = candResults.length;
  let maxRej = null;
  const limitDeadline = Date.now() + 300000;
  while (Date.now() < limitDeadline) {
    const before = rejects.length;
    cSock.emit('interview-submit');
    await sleep(1500);
    const fresh = rejects.slice(before);
    if (!fresh.length) continue;
    const limitHit = fresh.find((r) => /Maximum of/i.test(r.reason || ''));
    if (limitHit) { maxRej = limitHit.reason; break; }
    // Only the transient rejection may be ignored here.
    if (!fresh.every((r) => /already being judged/i.test(r.reason || ''))) {
      maxRej = fresh[fresh.length - 1].reason;
      break;
    }
  }
  if (maxRej === null) throw new Error(`no rejection after ${maxSub} submissions (used=${usedBefore})`);
  if (!/Maximum of/i.test(maxRej)) throw new Error(`unexpected rejection reason: "${maxRej}"`);
  notes.push(`over ${maxSub} submissions -> rejected: "${maxRej}"`);

  return { notes, candResults, ivSubs, rejects };
}
// ---------- (g) timer ----------
async function testG() {
  const notes = [];
  const ivSock = await connect();
  const ivDoc = attachDoc(ivSock);
  const ack = await ackOf(ivSock, 'create-interview', { userName: 'TimInt' });
  const roomId = ack.roomId;
  const intKey = ack.interviewerKey;
  const cSock = await connect();
  const cDoc = attachDoc(cSock);
  const cAck = await ackOf(cSock, 'join-interview', { roomId, userName: 'TimCand' });
  const candKey = cAck.candidateKey;
  await sleep(700);

  ivSock.emit('interview-configure', { problemId: 'two-sum', durationMs: 3000 });
  await sleep(500);
  const cSock2 = await connect();
  const cDoc2 = attachDoc(cSock2);
  const cAck2 = await ackOf(cSock2, 'join-interview', { roomId, userName: 'TimCand', candidateKey: candKey });
  if (!cAck2.ok) throw new Error('candidate rejoin failed');
  await sleep(600);

  const candResults = collect(cSock2, 'submission-result');
  const rejects = collect(cSock2, 'submission-rejected');
  const endedP = Promise.all([
    waitFor(ivSock, 'interview-ended', 25000),
    waitFor(cSock2, 'interview-ended', 25000),
  ]);
  ivSock.emit('interview-start');
  await sleep(700);

  // change the code AFTER start so the final auto judge has something to run.
  // The room language must be python too: the judge always uses room.language.
  cSock2.emit('languageChange', { language: 'python' });
  await sleep(300);
  setDocText(cDoc2, PY_CORRECT);
  await sleep(600);

  const [ivEnded, cEnded] = await withTimeout(endedP, 30000, 'interview-ended');
  if (ivEnded.endReason !== 'time') throw new Error(`endReason=${ivEnded.endReason}`);
  if (cEnded.endReason !== 'time') throw new Error(`candidate endReason=${cEnded.endReason}`);
  notes.push(`ended endReason=time endedAt=${ivEnded.endedAt}`);

  const t0 = Date.now();
  while (candResults.length === 0 && Date.now() - t0 < 60000) await sleep(300);
  if (!candResults.length) throw new Error('no final auto judge submission-result');
  const auto = candResults[candResults.length - 1];
  notes.push(`auto final judge verdict=${auto.verdict} passed=${auto.passed}/${auto.total}`);

  const rejBefore = rejects.length;
  cSock2.emit('interview-submit');
  await sleep(700);
  if (rejects.length === rejBefore) throw new Error('submit after end not rejected');
  notes.push(`submit after end rejected: "${rejects[rejects.length - 1].reason}"`);

  const textBefore = ivDoc.getText('monaco').toString();
  setDocText(cDoc2, 'EDIT_AFTER_END');
  await sleep(800);
  const textAfter = ivDoc.getText('monaco').toString();
  if (textAfter.includes('EDIT_AFTER_END')) throw new Error('candidate edit after end was accepted');
  notes.push(`yjs-update after end ignored (${textBefore.length}->${textAfter.length})`);

  return { roomId, intKey, ivSock, cSock2, notes };
}

// ---------- (h) manual end ----------
async function testH() {
  const notes = [];
  const ivSock = await connect();
  const ivDoc = attachDoc(ivSock);
  const ack = await ackOf(ivSock, 'create-interview', { userName: 'ManInt' });
  const cSock = await connect();
  const cDoc = attachDoc(cSock);
  const cAck = await ackOf(cSock, 'join-interview', { roomId: ack.roomId, userName: 'ManCand' });
  const candKey = cAck.candidateKey;
  await sleep(700);
  ivSock.emit('interview-configure', { problemId: 'two-sum', durationMin: 30 });
  await sleep(400);
  const c2 = await connect();
  const cDoc2 = attachDoc(c2);
  await ackOf(c2, 'join-interview', { roomId: ack.roomId, userName: 'ManCand', candidateKey: candKey });
  await sleep(600);
  ivSock.emit('interview-start');
  await sleep(700);
  const endedP = waitFor(ivSock, 'interview-ended', 20000);
  ivSock.emit('interview-end');
  const ended = await withTimeout(endedP, 25000, 'interview-ended');
  if (ended.endReason !== 'manual') throw new Error(`endReason=${ended.endReason}`);
  notes.push(`manual end endReason=${ended.endReason} endedAt=${ended.endedAt}`);
  return { roomId: ack.roomId, intKey: ack.interviewerKey, ivSock, cSock: c2, notes };
}
// ---------- (i) report ----------
async function testI(hctx) {
  const { roomId, intKey } = hctx;
  const notes = [];
  // "interview-ended" is emitted BEFORE the final auto-judge runs, and the
  // judge needs several Wandbox round-trips. Poll until the report contains
  // the final submission.
  let r = null;
  let rep = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 180000) {
    r = await fetch(`${BASE}/api/interview/${roomId}/report`, { headers: { 'x-interviewer-key': intKey } });
    if (r.status === 200) {
      const cand = await r.json();
      if (cand && cand.final) { rep = cand; break; }
    }
    await sleep(2000);
  }
  if (!rep) throw new Error(`report never reached "final" (last status=${r && r.status})`);
  notes.push(`correct key -> 200 (after ${Date.now() - t0}ms wait for final judge)`);
  if (rep.roomId !== roomId) throw new Error(`roomId=${rep.roomId}`);
  if (!rep.problem || rep.problem.id !== 'two-sum') throw new Error(`problem=${JSON.stringify(rep.problem)}`);
  if (rep.endReason !== 'manual') throw new Error(`endReason=${rep.endReason}`);
  if (!rep.replayPath || !rep.replayPath.includes(roomId)) throw new Error(`replayPath=${rep.replayPath}`);
  if (!Array.isArray(rep.submissions)) throw new Error('submissions not an array');
  if (!rep.final) throw new Error('final missing');
  if ('expected' in rep.final) throw new Error('final leaks expected');
  if (rep._interviewerKey) throw new Error('internal key leaked in response');
  if (!('usedMs' in rep) || !('durationMs' in rep)) throw new Error('usedMs/durationMs missing');
  notes.push(`report keys=${Object.keys(rep).join(',')}`);
  notes.push(`final verdict=${rep.final.verdict} passed=${rep.final.passed}/${rep.final.total}`);
  if (!rep.submissions.length) throw new Error('report has no submissions');
  const st = rep.submissions[0].tests[0];
  if (!('input' in st) || !('expected' in st)) throw new Error('report submission lacks hidden detail');

  r = await fetch(`${BASE}/api/interview/${roomId}/report`, { headers: { 'x-interviewer-key': 'wrong-key' } });
  if (r.status !== 403) throw new Error(`wrong key -> ${r.status}`);
  notes.push('wrong key -> 403');
  r = await fetch(`${BASE}/api/interview/${roomId}/report`);
  if (r.status !== 403) throw new Error(`no key -> ${r.status}`);
  notes.push('no key -> 403');
  r = await fetch(`${BASE}/api/interview/zzzzzzzz/report`, { headers: { 'x-interviewer-key': intKey } });
  if (r.status !== 404) throw new Error(`unknown room -> ${r.status}`);
  notes.push('unknown room -> 404');
  r = await fetch(`${BASE}/api/interview/${'a'.repeat(101)}/report`, { headers: { 'x-interviewer-key': intKey } });
  if (r.status !== 400) throw new Error(`long roomId -> ${r.status}`);
  notes.push('101-char roomId -> 400');

  const iv2 = await connect();
  const ack2 = await ackOf(iv2, 'create-interview', { userName: 'Unfin' });
  r = await fetch(`${BASE}/api/interview/${ack2.roomId}/report`, { headers: { 'x-interviewer-key': ack2.interviewerKey } });
  if (r.status !== 409) throw new Error(`unfinished -> ${r.status}`);
  const body = await r.json();
  if (body.error !== 'Interview not finished') throw new Error(`409 body=${JSON.stringify(body)}`);
  notes.push('unfinished -> 409 "Interview not finished"');
  iv2.disconnect();

  const rr = await fetch(`${BASE}/api/replay/${roomId}`);
  if (rr.status !== 200) throw new Error(`replay -> ${rr.status}`);
  const recData = await rr.json();
  const marks = recData.events.filter((e) => e.k === 'mark').map((e) => e.label);
  if (!marks.length) throw new Error('no mark events in replay');
  notes.push(`replay marks=${JSON.stringify(marks)}`);

  return { notes, report: rep };
}
// ---------- (j) grace ----------
async function testJ() {
  const notes = [];
  // scenario 1: everyone leaves while running, interviewer rejoins within grace
  const ivSock = await connect();
  const ivDoc = attachDoc(ivSock);
  const ack = await ackOf(ivSock, 'create-interview', { userName: 'GraceInt' });
  const roomId = ack.roomId;
  const intKey = ack.interviewerKey;
  const cSock = await connect();
  const cDoc = attachDoc(cSock);
  const cAck = await ackOf(cSock, 'join-interview', { roomId, userName: 'GraceCand' });
  const candKey = cAck.candidateKey;
  await sleep(700);
  ivSock.emit('interview-configure', { problemId: 'two-sum', durationMs: 600000 });
  await sleep(400);
  const c2 = await connect();
  const cDoc2 = attachDoc(c2);
  await ackOf(c2, 'join-interview', { roomId, userName: 'GraceCand', candidateKey: candKey });
  await sleep(600);
  ivSock.emit('interview-start');
  await sleep(700);
  setDocText(cDoc2, 'GRACE_DOC_TEXT');
  await sleep(700);

  ivSock.emit('leave-room');
  c2.emit('leave-room');
  await sleep(400);
  let r = await fetch(`${BASE}/api/interview/${roomId}/report`, { headers: { 'x-interviewer-key': intKey } });
  if (r.status !== 409) throw new Error(`after all left, report -> ${r.status} (expected 409 = still live)`);
  notes.push('after all left: room still live (409), not deleted immediately');

  const iv2 = await connect();
  const ivDoc2 = attachDoc(iv2);
  const reAck = await ackOf(iv2, 'join-interview', { roomId, userName: 'GraceInt', interviewerKey: intKey });
  if (!reAck.ok) throw new Error(`rejoin failed: ${JSON.stringify(reAck)}`);
  // The rejoin itself broadcasts the state; "interview-start" is a no-op
  // because the interview is already running.
  const st = await waitState(iv2, (s) => s.status === 'running', 10000);
  if (st.status !== 'running') throw new Error(`status after rejoin = ${st.status}`);
  const text = ivDoc2.getText('monaco').toString();
  if (!text.includes('GRACE_DOC_TEXT')) throw new Error(`doc text lost after rejoin: "${text}"`);
  notes.push(`rejoined within grace: status=${st.status}, doc preserved (${text.length} chars)`);
  iv2.disconnect();

  // scenario 2: nobody rejoins -> abandoned after grace
  const iv3 = await connect();
  const ack3 = await ackOf(iv3, 'create-interview', { userName: 'AbandonInt' });
  const room3 = ack3.roomId;
  const key3 = ack3.interviewerKey;
  const c3 = await connect();
  await ackOf(c3, 'join-interview', { roomId: room3, userName: 'AbandonCand' });
  await sleep(500);
  iv3.emit('interview-configure', { problemId: 'two-sum', durationMs: 600000 });
  await sleep(400);
  iv3.emit('interview-start');
  await sleep(700);
  iv3.emit('leave-room');
  c3.emit('leave-room');
  await sleep(4000);
  r = await fetch(`${BASE}/api/interview/${room3}/report`, { headers: { 'x-interviewer-key': key3 } });
  if (r.status !== 200) throw new Error(`abandoned report -> ${r.status}`);
  const rep3 = await r.json();
  if (rep3.endReason !== 'abandoned') throw new Error(`endReason=${rep3.endReason} (expected abandoned)`);
  notes.push(`grace expired -> report 200 endReason=${rep3.endReason} endedAt=${rep3.endedAt}`);

  return { notes };
}
// ---------- (k) regression: normal room still works ----------
async function testK() {
  const notes = [];
  const s1 = await connect();
  const s2 = await connect();
  const d1 = attachDoc(s1);
  const d2 = attachDoc(s2);
  s1.emit('join', { roomId: 'normreg1', userName: 'N1' });
  await sleep(500);
  s2.emit('join', { roomId: 'normreg1', userName: 'N2' });
  await sleep(700);
  setDocText(d1, 'HELLO_NORMAL');
  await sleep(800);
  const t1 = d1.getText('monaco').toString();
  const t2 = d2.getText('monaco').toString();
  if (t1 !== t2) throw new Error(`not converged: "${t1}" vs "${t2}"`);
  notes.push(`converged "${t1}"`);

  // compileCode with stdin
  const runP = waitFor(s1, 'codeResponse', 45000);
  s1.emit('compileCode', { input: '5\n' });
  const run = await withTimeout(runP, 50000, 'codeResponse');
  notes.push(`codeResponse output=${JSON.stringify(String(run.run?.output ?? '').slice(0, 40))}`);

  // replay endpoint works
  const rr = await fetch(`${BASE}/api/replay/normreg1`);
  if (rr.status !== 200) throw new Error(`replay -> ${rr.status}`);
  notes.push(`replay 200 events=${(await rr.json()).events.length}`);

  // leave deletes the room. NOTE: /api/replay keeps serving the FINISHED
  // recording (200 with endedAt set) by design (Step 3), so the room deletion
  // is proven by the recording being closed AND a fresh joiner seeing the
  // default seed text again.
  s1.emit('leave-room');
  s2.emit('leave-room');
  await sleep(700);
  const rr2 = await fetch(`${BASE}/api/replay/normreg1`);
  if (rr2.status !== 200) throw new Error(`replay after leave -> ${rr2.status}`);
  const rec2 = await rr2.json();
  if (rec2.endedAt === null) throw new Error('recording still open (endedAt=null) -> room not finalized');
  notes.push(`leave -> room finalized (replay 200, endedAt=${rec2.endedAt})`);
  // A fresh joiner must get a brand new room with the default seed.
  const s3 = await connect();
  const d3 = attachDoc(s3);
  s3.emit('join', { roomId: 'normreg1', userName: 'N3' });
  await sleep(900);
  const fresh = d3.getText('monaco').toString();
  if (fresh !== '// Start your code here') throw new Error(`fresh join saw "${fresh}" (room not deleted)`);
  notes.push('fresh join -> default seed text (room was deleted)');
  s3.disconnect();
  s1.disconnect(); s2.disconnect();
  return { notes };
}

// ---------- (l) malformed payloads ----------
async function testL() {
  const notes = [];
  const bad = [null, undefined, 'string', 123, true, [], { roomId: null }, { roomId: 1, userName: 2 },
    { roomId: 'x'.repeat(5000), userName: 'y'.repeat(5000) },
    { problemId: { $ne: 1 }, durationMin: 'abc' },
    { problemId: 'two-sum', durationMin: Number.MAX_SAFE_INTEGER },
    { problemId: 'two-sum', durationMs: -1 },
    { problemId: 'two-sum', durationMs: 1e308 }];
  const s = await connect();
  for (const p of bad) {
    try { s.emit('create-interview', p, () => {}); } catch (e) { throw new Error(`create-interview threw on ${JSON.stringify(p)}: ${e.message}`); }
    try { s.emit('join-interview', p, () => {}); } catch (e) { throw new Error(`join-interview threw: ${e.message}`); }
    try { s.emit('interview-configure', p); } catch (e) { throw new Error(`interview-configure threw: ${e.message}`); }
    try { s.emit('interview-start', p); } catch (e) { throw new Error(`interview-start threw: ${e.message}`); }
    try { s.emit('interview-end', p); } catch (e) { throw new Error(`interview-end threw: ${e.message}`); }
    try { s.emit('interview-submit', p); } catch (e) { throw new Error(`interview-submit threw: ${e.message}`); }
    try { s.emit('yjs-update', p); } catch (e) { throw new Error(`yjs-update threw: ${e.message}`); }
    try { s.emit('compileCode', p); } catch (e) { throw new Error(`compileCode threw: ${e.message}`); }
  }
  await sleep(1500);
  if (backend && backend.exitCode !== null) throw new Error(`backend exited code=${backend.exitCode}`);
  const log = fs.readFileSync(LOG, 'utf8');
  const bad2 = log.match(/uncaught|unhandled|UnhandledPromiseRejection|FATAL|ERR_UNHANDLED/gi);
  if (bad2) throw new Error(`log markers: ${JSON.stringify([...new Set(bad2)])}`);
  notes.push(`${bad.length} malformed payloads x 8 events -> no crash, no uncaught errors`);
  s.disconnect();
  return { notes };
}

// ---------- runner ----------
// Global force-exit. Wandbox round-trips take 8-20s each and the judge runs
// 5 hidden tests per submission, so the suite needs a generous budget.
const GLOBAL_MS = 900000;
let exitCode = 0;

async function main() {
  startBackend();
  await waitForServer(BASE);

  const run = async (name, ms, fn, fmt) => {
    const t0 = Date.now();
    try {
      const r = await withTimeout(fn(), ms, name);
      const detail = fmt ? fmt(r) : ((r && r.notes) ? r.notes.join(' | ') : (typeof r === 'string' ? r : ''));
      rec(name, true, detail);
      return r;
    } catch (e) {
      rec(name, false, `${e.message} (${Date.now() - t0}ms)`);
      return null;
    }
  };

  await run('a-reference-validation', 60000, testA);

  const ctx = {};
  const b = await run('b-create-interview', 20000, testB,
    (r) => `roomId=${r.roomId} keyLen=${r.interviewerKey.length} bank=4 entries, no hidden keys`);
  if (b) Object.assign(ctx, b);

  const c = await run('c-join-interview', 40000, () => testC(ctx));
  if (c) Object.assign(ctx, c);

  const d = await run('d-permissions', 40000, () => testD(ctx));
  if (d) Object.assign(ctx, d);

  await run('e-confidentiality', 180000, () => testE(ctx),
    (r) => `candidate received events: ${r.events} (${r.bytes} bytes JSON scanned)`);

  // f-judging runs 4 full submissions (5 hidden tests each) plus the
  // max-submissions probe, so it needs a generous budget.
  await run('f-judging', 480000, () => testF(ctx));

  await run('g-timer', 240000, () => testG());

  const h = await run('h-manual-end', 120000, () => testH());
  if (h) Object.assign(ctx, h);

  await run('i-report', 240000, () => testI(ctx));
  await run('j-grace', 180000, () => testJ());

  await run('k-regression', 120000, () => testK());

  await run('l-malformed', 40000, () => testL());

  // trust proxy present
  const src = fs.readFileSync(path.join(root, 'Backend', 'index.js'), 'utf8');
  if (!/app\.set\(\s*['"]trust proxy['"]\s*,\s*1\s*\)/.test(src)) {
    rec('k2-trust-proxy', false, 'app.set("trust proxy", 1) not found');
  } else {
    rec('k2-trust-proxy', true, 'app.set("trust proxy", 1) found in Backend/index.js');
  }
}

main()
  .then(() => { exitCode = results.some((r) => !r.pass) ? 1 : 0; })
  .catch((e) => { console.error('FATAL', e); exitCode = 2; })
  .finally(() => {
    const p = results.filter((r) => r.pass).length;
    console.log(`\n=== ${p}/${results.length} passed ===`);
    killBackend();
    setTimeout(() => process.exit(exitCode), 100);
  });

setTimeout(() => {
  console.error('GLOBAL 240s FORCE EXIT');
  killBackend();
  process.exit(9);
}, GLOBAL_MS);








