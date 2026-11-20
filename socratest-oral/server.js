// 국어 구술 수행평가 도우미 – 교실 PC용 서버
// 흐름: 학생 음성 녹음 → 텍스트 전사 → Claude 잠정 평가 → 교사 검토·최종 피드백
//  [수행 연습] 1 1차 구술 → 2 AI 평가·1차 피드백 → 3 수정 구술 → 4 AI 평가 → 5 AI 2차 피드백
//  [실전 평가] 6 최종 구술(2차 피드백 반영) → 7 AI 평가·피드백 → 교사 최종 피드백
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { exec } from 'node:child_process';
import QRCode from 'qrcode';
import { generate as generateCert } from 'selfsigned';
import { db, config, saveDb, saveDbNow, saveConfig, findClass, findStudent, studentsOf, sha256File, DATA_DIR, AUDIO_DIR, TMP_DIR } from './lib/store.js';
import * as auth from './lib/auth.js';
import { AREAS, parseRubric, rubricToText } from './lib/rubrics.js';
import { evaluate, testConnection, MODELS } from './lib/ai.js';
import { transcribeWithOpenAI } from './lib/stt.js';

const HTTP_PORT = Number(process.env.PORT || 3000);
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 3443);
const PUBLIC_DIR = path.resolve('public');
const MAX_AUDIO = 30 * 1024 * 1024;
const STEP_OF_ATTEMPT = { 1: 1, 2: 3, 3: 6 }; // 구술 회차 → 단계 번호
const ATTEMPT_LABEL = { 1: '1차 구술(1단계)', 2: '수정 구술(3단계)', 3: '실전 최종 구술(6단계)' };

// ───────────────────────── 공통 도우미 ─────────────────────────
const str = (v, n = 200) => String(v ?? '').trim().slice(0, n);
function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, msg) => {
  throw new HttpError(status, msg);
};
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, '보낸 자료가 너무 큽니다.'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req) {
  const buf = await readBody(req, 1024 * 1024);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    fail(400, '요청 형식 오류');
  }
}
const isLocal = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
const bearer = (req, url) => (req.headers.authorization || '').replace(/^Bearer /, '') || url.searchParams.get('t') || '';
function requireTeacher(req, url) {
  const p = auth.readToken(bearer(req, url));
  if (p?.role !== 'teacher') fail(401, '교사 로그인이 필요합니다.');
}
function requireStudent(req, url) {
  const p = auth.readToken(bearer(req, url));
  const s = p?.role === 'student' && findStudent(p.id);
  if (!s) fail(401, '접속이 만료되었습니다. 수업 코드·이름·PIN으로 다시 입장하세요.');
  const cls = findClass(s.classCode);
  if (!cls) fail(404, '수업이 삭제되었습니다.');
  return { s, cls };
}
function log(s, event, detail = '') {
  s.log.push({ at: Date.now(), event, detail: String(detail).slice(0, 300) });
}
function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push({ name, ip: a.address });
  }
  return out;
}
const audioPath = (rel) => path.join(AUDIO_DIR, rel);
const EXT = { 'audio/webm': '.webm', 'audio/ogg': '.ogg', 'audio/mp4': '.m4a', 'audio/x-m4a': '.m4a', 'audio/aac': '.aac', 'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/x-wav': '.wav' };
const MIME = Object.fromEntries(Object.entries(EXT).map(([m, e]) => [e, m]));

// ───────────────────────── 진행 단계 계산 ─────────────────────────
// 반환값: 0 마감, 1~7 진행 단계, 5 연습 완료(실전 대기), 8 교사 확정 대기, 9 최종 결과 공개
function stepOf(cls, s) {
  const A = s.attempts;
  const E = s.evals;
  if (A.a3) return E.e3 ? (s.final?.published ? 9 : 8) : 7;
  if (cls.phase === 'closed') return 0;
  if (cls.phase === 'assessment') {
    if (A.a1 && !E.e1) return 2;
    if (A.a2 && !E.e2) return 4;
    return 6;
  }
  if (!A.a1) return 1;
  if (!E.e1) return 2;
  if (!A.a2) return 3;
  if (!E.e2) return 4;
  return 5;
}
const recordableAttempt = (step) => ({ 1: 1, 3: 2, 6: 3 })[step] || 0;

// ───────────────────────── 처리 대기열(전사 → AI 평가) ─────────────────────────
// 학생 30명이 한꺼번에 제출해도 동시에 3건씩만 처리해 API 제한·요금 폭증을 막습니다.
const jobs = [];
let running = 0;
function enqueue(sid, n) {
  if (!jobs.some((j) => j.sid === sid && j.n === n)) jobs.push({ sid, n });
  pump();
}
function pump() {
  while (running < 3 && jobs.length) {
    const job = jobs.shift();
    running++;
    runJob(job).finally(() => {
      running--;
      pump();
    });
  }
}
async function runJob({ sid, n }) {
  const s = findStudent(sid);
  const cls = s && findClass(s.classCode);
  const at = s?.attempts['a' + n];
  if (!at) return;
  try {
    if (config.sttProvider === 'openai' && !['teacher', 'openai'].includes(at.transcriptSource)) {
      at.state = 'transcribing';
      saveDb();
      const t = await transcribeWithOpenAI(audioPath(at.file), at.mime, `${cls.title}. ${cls.task}`);
      at.transcript = t;
      at.transcriptSource = 'openai';
      at.transcriptHistory.push({ at: Date.now(), source: 'openai', text: t });
    }
    if (!at.transcript.trim()) {
      if (config.mock) {
        at.transcript = '(모의 전사) 음성 인식 결과가 없어 시험용 문장을 넣었습니다. 화자는 임과의 이별 상황에서 슬픔을 참는 정서를 보여 줍니다.';
        at.transcriptSource = 'mock';
      } else {
        at.state = 'needs_transcript';
        at.error = '음성 인식 결과가 비어 있습니다. 선생님이 녹음을 듣고 전사문을 입력하면 평가가 진행됩니다.';
        saveDb();
        return;
      }
    }
    at.state = 'evaluating';
    at.error = '';
    saveDb();
    const ev = await evaluate(cls, s, n);
    if (s.evals['e' + n]) s.evalHistory.push({ key: 'e' + n, ...s.evals['e' + n] });
    s.evals['e' + n] = { ...ev, at: Date.now() };
    at.state = 'done';
    log(s, 'AI 평가 완료', `${ATTEMPT_LABEL[n]} · ${ev.result.aiTotal}/${ev.result.aiMax}점 · ${ev.model}`);
  } catch (e) {
    at.state = 'error';
    at.error = e.message;
    log(s, 'AI 처리 오류', e.message);
  }
  saveDb();
}

// ───────────────────────── 화면에 보낼 자료 ─────────────────────────
function classForStudent(cls) {
  return {
    code: cls.code,
    title: cls.title,
    areaLabel: cls.areaLabel,
    passage: cls.passage,
    task: cls.task,
    rubric: cls.rubric,
    phase: cls.phase,
    maxSeconds: cls.maxSeconds,
    assessmentTakes: cls.assessmentTakes,
    sttProvider: config.sttProvider,
  };
}
function attemptView(at) {
  if (!at) return null;
  const { file, transcriptHistory, ...rest } = at;
  return rest;
}
function studentView(cls, s) {
  const step = stepOf(cls, s);
  const evals = {};
  if (s.evals.e1) evals.e1 = studentEval(s.evals.e1);
  if (s.evals.e2) evals.e2 = studentEval(s.evals.e2);
  // 실전 AI 평가는 교사가 허용했거나 최종 결과를 공개했을 때만 학생에게 보여 줍니다.
  if (s.evals.e3 && (cls.showAiInAssessment || s.final?.published)) evals.e3 = studentEval(s.evals.e3);
  return {
    class: classForStudent(cls),
    id: s.id,
    alias: s.alias,
    step,
    recordFor: recordableAttempt(step),
    takesUsed: s.takes?.a3 || 0,
    attempts: { a1: attemptView(s.attempts.a1), a2: attemptView(s.attempts.a2), a3: attemptView(s.attempts.a3) },
    evals,
    final: s.final?.published ? (({ record, ...f }) => f)(s.final) : null, // 세특 참고 문장은 교사 전용
    objections: s.objections,
  };
}
// 학생에게는 교사용 메모(teacherNote, recordDraft)를 보내지 않습니다.
function studentEval(ev) {
  const { teacherNote, recordDraft, transcriptIssues, ...r } = ev.result;
  return { ...r, at: ev.at };
}
function teacherStudent(cls, s) {
  return {
    id: s.id,
    alias: s.alias,
    created: s.created,
    step: stepOf(cls, s),
    takes: s.takes || {},
    attempts: s.attempts,
    evals: s.evals,
    evalHistory: s.evalHistory,
    archive: s.archive,
    final: s.final,
    objections: s.objections,
    log: s.log,
  };
}
function classSummary(c) {
  const list = studentsOf(c.code);
  return {
    ...c,
    rubricText: rubricToText(c.rubric),
    count: list.length,
    practiceDone: list.filter((s) => s.evals.e2).length,
    assessmentDone: list.filter((s) => s.evals.e3).length,
    published: list.filter((s) => s.final?.published).length,
    objectionsOpen: list.reduce((n, s) => n + s.objections.filter((o) => !o.reply).length, 0),
  };
}

// ───────────────────────── 라우팅 ─────────────────────────
const routes = [];
const route = (method, pattern, handler) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
  routes.push({ method, re, keys, handler });
};

// 상태·초기 설정
route('GET', '/api/status', (req) => ({
  setupDone: !!config.passwordHash,
  isLocal: isLocal(req),
  aiReady: config.mock || !!config.anthropicKey,
  mock: config.mock,
}));
route('POST', '/api/setup', async (req) => {
  if (config.passwordHash) fail(400, '이미 설정되어 있습니다.');
  if (!isLocal(req)) fail(403, '최초 설정은 교사 PC(이 컴퓨터)에서만 할 수 있습니다.');
  const { password } = await readJson(req);
  if (str(password, 200).length < 8) fail(400, '비밀번호는 8자 이상으로 정하세요.');
  auth.setTeacherPassword(str(password, 200));
  return { token: auth.teacherToken() };
});
route('POST', '/api/teacher/login', async (req) => {
  const ip = req.socket.remoteAddress;
  if (auth.loginBlocked(ip)) fail(429, '비밀번호를 여러 번 틀렸습니다. 1분 뒤 다시 시도하세요.');
  const { password } = await readJson(req);
  if (!auth.checkTeacherPassword(str(password, 200))) {
    auth.loginFailed(ip);
    fail(401, '비밀번호가 다릅니다.');
  }
  auth.loginOk(ip);
  return { token: auth.teacherToken() };
});

// 교사 설정
const mask = (k) => (k ? k.slice(0, 7) + '…' + k.slice(-4) : '');
route('GET', '/api/settings', (req, url) => {
  requireTeacher(req, url);
  return {
    model: config.model,
    effort: config.effort,
    sttProvider: config.sttProvider,
    openaiSttModel: config.openaiSttModel,
    mock: config.mock,
    anthropicKey: mask(config.anthropicKey),
    openaiKey: mask(config.openaiKey),
    models: MODELS,
    dataDir: DATA_DIR,
  };
});
route('POST', '/api/settings', async (req, url) => {
  requireTeacher(req, url);
  const b = await readJson(req);
  if (b.anthropicKey !== undefined && b.anthropicKey !== '') config.anthropicKey = str(b.anthropicKey, 300);
  if (b.openaiKey !== undefined && b.openaiKey !== '') config.openaiKey = str(b.openaiKey, 300);
  if (b.clearOpenaiKey) delete config.openaiKey;
  if (MODELS[b.model]) config.model = b.model;
  if (['low', 'medium', 'high'].includes(b.effort)) config.effort = b.effort;
  if (['browser', 'openai'].includes(b.sttProvider)) config.sttProvider = b.sttProvider;
  if (b.openaiSttModel) config.openaiSttModel = str(b.openaiSttModel, 60);
  if (typeof b.mock === 'boolean') config.mock = b.mock;
  if (b.newPassword) {
    if (str(b.newPassword, 200).length < 8) fail(400, '새 비밀번호는 8자 이상이어야 합니다.');
    auth.setTeacherPassword(str(b.newPassword, 200));
  }
  saveConfig();
  return { ok: true, token: b.newPassword ? auth.teacherToken() : undefined };
});
route('POST', '/api/settings/test', async (req, url) => {
  requireTeacher(req, url);
  try {
    return { message: await testConnection() };
  } catch (e) {
    fail(502, e.message);
  }
});
route('GET', '/api/network', (req, url) => {
  requireTeacher(req, url);
  return { addresses: lanAddresses(), httpsPort: HTTPS_PORT, httpPort: HTTP_PORT };
});
route('GET', '/api/areas', () => Object.fromEntries(Object.entries(AREAS).map(([k, v]) => [k, { label: v.label, task: v.task, rubricText: v.rubric.join('\n') }])));

// 수업 관리
function applyClassFields(c, b) {
  if (b.title !== undefined) c.title = str(b.title, 100);
  if (b.area !== undefined && AREAS[b.area]) {
    c.area = b.area;
    c.areaLabel = AREAS[b.area].label;
  }
  if (b.passage !== undefined) c.passage = str(b.passage, 20000);
  if (b.task !== undefined) c.task = str(b.task, 2000);
  if (b.standard !== undefined) c.standard = str(b.standard, 1500);
  if (b.rubricText !== undefined) {
    const r = parseRubric(b.rubricText);
    if (!r.length) fail(400, '평가 기준을 한 줄에 하나씩 "기준명 | 배점 | 설명" 형식으로 입력하세요.');
    if (!r.some((x) => !x.teacherOnly)) fail(400, 'AI가 채점할 기준이 하나 이상 있어야 합니다.');
    c.rubric = r;
  }
  if (b.maxSeconds !== undefined) c.maxSeconds = Math.max(30, Math.min(600, Number(b.maxSeconds) || 180));
  if (b.assessmentTakes !== undefined) c.assessmentTakes = Math.max(1, Math.min(3, Number(b.assessmentTakes) || 1));
  if (b.showAiInAssessment !== undefined) c.showAiInAssessment = !!b.showAiInAssessment;
  if (b.phase !== undefined && ['practice', 'assessment', 'closed'].includes(b.phase)) c.phase = b.phase;
  if (c.title.length < 2) fail(400, '수업 제목을 2자 이상 입력하세요.');
  if (c.passage.length < 20) fail(400, '제시문(작품·지문)을 20자 이상 입력하세요.');
  if (c.task.length < 5) fail(400, '구술 과제(학생에게 묻는 질문)를 입력하세요.');
}
route('GET', '/api/classes', (req, url) => {
  requireTeacher(req, url);
  return db.classes.map(classSummary).reverse();
});
route('POST', '/api/classes', async (req, url) => {
  requireTeacher(req, url);
  const b = await readJson(req);
  let code;
  do code = crypto.randomBytes(3).toString('hex').toUpperCase();
  while (findClass(code));
  const area = AREAS[b.area] ? b.area : 'free';
  const c = { code, title: '', area, areaLabel: AREAS[area].label, passage: '', task: '', standard: '', rubric: parseRubric(AREAS[area].rubric), phase: 'practice', maxSeconds: 180, assessmentTakes: 1, showAiInAssessment: false, created: Date.now() };
  applyClassFields(c, b);
  db.classes.push(c);
  saveDbNow();
  return classSummary(c);
});
route('PUT', '/api/classes/:code', async (req, url, p) => {
  requireTeacher(req, url);
  const c = findClass(p.code) || fail(404, '수업 없음');
  const b = await readJson(req);
  const copy = structuredClone(c);
  applyClassFields(copy, b); // 검증을 통과했을 때만 반영
  Object.assign(c, copy);
  saveDbNow();
  return classSummary(c);
});
route('DELETE', '/api/classes/:code', (req, url, p) => {
  requireTeacher(req, url);
  const c = findClass(p.code) || fail(404, '수업 없음');
  db.classes.splice(db.classes.indexOf(c), 1);
  db.students = db.students.filter((s) => s.classCode !== c.code);
  fs.rmSync(path.join(AUDIO_DIR, c.code), { recursive: true, force: true });
  saveDbNow();
  return { ok: true };
});
route('GET', '/api/classes/:code/qr', async (req, url, p) => {
  requireTeacher(req, url);
  const c = findClass(p.code) || fail(404, '수업 없음');
  const host = str(url.searchParams.get('host'), 60) || lanAddresses()[0]?.ip || 'localhost';
  const link = `https://${host}:${HTTPS_PORT}/student.html?code=${c.code}`;
  return { link, dataUrl: await QRCode.toDataURL(link, { width: 420, margin: 2 }) };
});
route('GET', '/api/classes/:code/students', (req, url, p) => {
  requireTeacher(req, url);
  const c = findClass(p.code) || fail(404, '수업 없음');
  return { class: classSummary(c), students: studentsOf(c.code).map((s) => teacherStudent(c, s)), queue: jobs.length + running };
});

// 학생 개별 관리(교사)
function teacherStudentCtx(req, url, p) {
  requireTeacher(req, url);
  const s = findStudent(p.id) || fail(404, '학생 없음');
  return { s, cls: findClass(s.classCode) };
}
route('GET', '/api/students/:id', (req, url, p) => {
  const { s, cls } = teacherStudentCtx(req, url, p);
  return { class: classSummary(cls), student: teacherStudent(cls, s) };
});
route('POST', '/api/students/:id/transcript', async (req, url, p) => {
  const { s } = teacherStudentCtx(req, url, p);
  const b = await readJson(req);
  const n = Number(b.n);
  const at = s.attempts['a' + n] || fail(404, '해당 구술이 없습니다.');
  const text = str(b.text, 8000);
  if (text.length < 2) fail(400, '전사문을 입력하세요.');
  at.transcript = text;
  at.transcriptSource = 'teacher';
  at.transcriptHistory.push({ at: Date.now(), source: 'teacher', text });
  log(s, '교사 전사문 수정', ATTEMPT_LABEL[n]);
  if (b.reevaluate) {
    at.state = 'queued';
    enqueue(s.id, n);
  }
  saveDb();
  return { ok: true };
});
route('POST', '/api/students/:id/reevaluate', async (req, url, p) => {
  const { s } = teacherStudentCtx(req, url, p);
  const n = Number((await readJson(req)).n);
  const at = s.attempts['a' + n] || fail(404, '해당 구술이 없습니다.');
  at.state = 'queued';
  enqueue(s.id, n);
  log(s, '교사 AI 재평가 요청', ATTEMPT_LABEL[n]);
  saveDb();
  return { ok: true };
});
// 단계 되돌리기: 기기 고장 등으로 다시 녹음하게 할 때. 기존 녹음·평가는 삭제하지 않고 보관함으로 옮깁니다.
route('POST', '/api/students/:id/reset', async (req, url, p) => {
  const { s } = teacherStudentCtx(req, url, p);
  const n = Number((await readJson(req)).n);
  if (![1, 2, 3].includes(n)) fail(400, '회차 오류');
  for (let k = n; k <= 3; k++) {
    if (s.attempts['a' + k] || s.evals['e' + k]) s.archive.push({ at: Date.now(), n: k, attempt: s.attempts['a' + k], eval: s.evals['e' + k] });
    delete s.attempts['a' + k];
    delete s.evals['e' + k];
    if (s.takes) delete s.takes['a' + k];
  }
  if (s.final) s.archive.push({ at: Date.now(), n: 'final', final: s.final });
  s.final = null;
  log(s, '교사 재응시 허용', `${ATTEMPT_LABEL[n]}부터 다시`);
  saveDbNow();
  return { ok: true };
});
route('POST', '/api/students/:id/final', async (req, url, p) => {
  const { s, cls } = teacherStudentCtx(req, url, p);
  const b = await readJson(req);
  const scores = {};
  for (const c of cls.rubric) {
    const v = b.scores?.[c.name];
    if (v === '' || v === null || v === undefined) fail(400, `'${c.name}' 점수를 입력하세요.`);
    const num = Number(v);
    if (!Number.isFinite(num) || num < 0 || num > c.points) fail(400, `'${c.name}' 점수는 0~${c.points}점입니다.`);
    scores[c.name] = num;
  }
  const wasPublished = s.final?.published;
  s.final = {
    scores,
    total: Object.values(scores).reduce((a, x) => a + x, 0),
    max: cls.rubric.reduce((a, c) => a + c.points, 0),
    feedback: str(b.feedback, 4000),
    record: str(b.record, 2000),
    published: !!b.publish || (wasPublished && b.publish !== false),
    savedAt: Date.now(),
    publishedAt: b.publish ? Date.now() : s.final?.publishedAt || null,
  };
  log(s, b.publish ? '교사 최종 피드백 공개' : '교사 최종 피드백 저장', `${s.final.total}/${s.final.max}점`);
  saveDbNow();
  return { ok: true, final: s.final };
});
route('POST', '/api/students/:id/objection/:idx', async (req, url, p) => {
  const { s } = teacherStudentCtx(req, url, p);
  const o = s.objections[Number(p.idx)] || fail(404, '이의제기 없음');
  o.reply = str((await readJson(req)).reply, 3000);
  o.repliedAt = Date.now();
  log(s, '이의제기 답변', o.reply.slice(0, 60));
  saveDbNow();
  return { ok: true };
});
route('DELETE', '/api/students/:id', (req, url, p) => {
  const { s } = teacherStudentCtx(req, url, p);
  db.students.splice(db.students.indexOf(s), 1);
  for (const at of [...Object.values(s.attempts), ...s.archive.map((x) => x.attempt).filter(Boolean)]) fs.rmSync(audioPath(at.file), { force: true });
  saveDbNow();
  return { ok: true };
});

// 내보내기
const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
route('GET', '/api/classes/:code/export.csv', (req, url, p) => {
  requireTeacher(req, url);
  const c = findClass(p.code) || fail(404, '수업 없음');
  const head = ['식별명', '진행 단계', '1차 AI', '수정 AI', '실전 AI', ...c.rubric.map((r) => `최종-${r.name}(${r.points})`), '최종 총점', '공개', '교사 최종 피드백', '세특 참고 문장', '실전 녹음 길이(초)', '실전 화면 이탈', '실전 녹음 SHA-256', '이의제기'];
  const ai = (e) => (e ? `${e.result.aiTotal}/${e.result.aiMax}` : '');
  const rows = studentsOf(c.code).map((s) => [
    s.alias,
    stepOf(c, s),
    ai(s.evals.e1),
    ai(s.evals.e2),
    ai(s.evals.e3),
    ...c.rubric.map((r) => s.final?.scores[r.name] ?? ''),
    s.final ? `${s.final.total}/${s.final.max}` : '',
    s.final?.published ? 'O' : '',
    s.final?.feedback || '',
    s.final?.record || '',
    s.attempts.a3?.durationSec ?? '',
    s.attempts.a3?.hiddenCount ?? '',
    s.attempts.a3?.sha256 || '',
    s.objections.map((o) => o.text).join(' / '),
  ]);
  const csv = '﻿' + [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
  return { __raw: csv, type: 'text/csv; charset=utf-8', filename: `구술평가_${c.code}.csv` };
});
route('GET', '/api/classes/:code/export.json', (req, url, p) => {
  requireTeacher(req, url);
  const c = findClass(p.code) || fail(404, '수업 없음');
  const data = { exportedAt: new Date().toISOString(), class: c, students: studentsOf(c.code) };
  return { __raw: JSON.stringify(data, null, 1), type: 'application/json; charset=utf-8', filename: `구술평가_${c.code}.json` };
});

// 녹음 재생(교사 또는 본인 학생만)
route('GET', '/api/audio/:id/:key', (req, url, p, res) => {
  const tok = auth.readToken(bearer(req, url));
  const s = findStudent(p.id) || fail(404, '학생 없음');
  if (!(tok?.role === 'teacher' || (tok?.role === 'student' && tok.id === s.id))) fail(401, '권한 없음');
  let at;
  if (p.key.startsWith('archive')) at = s.archive[Number(p.key.slice(7))]?.attempt;
  else at = s.attempts[p.key];
  if (!at) fail(404, '녹음 없음');
  const file = audioPath(at.file);
  if (!fs.existsSync(file)) fail(404, '녹음 파일이 없습니다.');
  const size = fs.statSync(file).size;
  const type = at.mime || MIME[path.extname(file)] || 'application/octet-stream';
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
  if (url.searchParams.get('download')) headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`;
  if (range) {
    const start = range[1] ? Number(range[1]) : size - Number(range[2]);
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    fs.createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { ...headers, 'Content-Length': size });
    fs.createReadStream(file).pipe(res);
  }
  return undefined;
});

// ── 학생 ──
route('GET', '/api/join-info/:code', (req, url, p) => {
  const c = findClass(p.code) || fail(404, '수업 코드를 확인하세요.');
  return { title: c.title, areaLabel: c.areaLabel, phase: c.phase };
});
route('POST', '/api/student/join', async (req) => {
  const b = await readJson(req);
  const c = findClass(str(b.code, 10)) || fail(404, '수업 코드를 확인하세요.');
  const alias = str(b.alias, 30).replace(/\s+/g, ' ');
  const pin = str(b.pin, 4);
  if (alias.length < 2) fail(400, '식별명을 2자 이상 입력하세요(예: 2-3-07).');
  if (!/^\d{4}$/.test(pin)) fail(400, 'PIN은 숫자 4자리입니다.');
  let s = db.students.find((x) => x.classCode === c.code && x.alias === alias);
  if (s) {
    if (auth.hashPin(pin, s.pinSalt) !== s.pinHash) fail(401, '이미 있는 식별명입니다. 처음 정한 PIN을 입력하거나 선생님께 문의하세요.');
    log(s, '재접속');
  } else {
    if (c.phase === 'closed') fail(400, '마감된 수업입니다.');
    const pinSalt = crypto.randomBytes(8).toString('hex');
    s = { id: crypto.randomUUID(), classCode: c.code, alias, pinSalt, pinHash: auth.hashPin(pin, pinSalt), created: Date.now(), attempts: {}, evals: {}, evalHistory: [], archive: [], takes: {}, final: null, objections: [], log: [] };
    db.students.push(s);
    log(s, '입장');
  }
  saveDb();
  return { token: auth.studentToken(s.id) };
});
route('GET', '/api/student/state', (req, url) => {
  const { s, cls } = requireStudent(req, url);
  return studentView(cls, s);
});
// 녹음 시작 기록: 실전 평가는 허용 횟수만큼만 녹음을 시작할 수 있습니다.
route('POST', '/api/student/record-start', async (req, url) => {
  const { s, cls } = requireStudent(req, url);
  const n = recordableAttempt(stepOf(cls, s));
  if (!n) fail(400, '지금은 녹음할 수 있는 단계가 아닙니다.');
  s.takes ??= {};
  const used = s.takes['a' + n] || 0;
  if (n === 3 && used >= cls.assessmentTakes) fail(403, `실전 평가 녹음 기회(${cls.assessmentTakes}회)를 모두 사용했습니다. 기기 문제라면 선생님께 말씀하세요.`);
  s.takes['a' + n] = used + 1;
  log(s, '녹음 시작', `${ATTEMPT_LABEL[n]} ${used + 1}번째`);
  saveDb();
  return { take: used + 1 };
});
route('POST', '/api/student/audio', async (req, url) => {
  requireStudent(req, url);
  const mime = String(req.headers['content-type'] || '').split(';')[0].trim();
  if (!EXT[mime]) fail(415, '지원하지 않는 녹음 형식입니다: ' + mime);
  const buf = await readBody(req, MAX_AUDIO);
  if (buf.length < 1000) fail(400, '녹음이 너무 짧거나 비어 있습니다. 마이크를 확인하세요.');
  const uploadId = crypto.randomUUID();
  fs.writeFileSync(path.join(TMP_DIR, uploadId + EXT[mime]), buf);
  return { uploadId, ext: EXT[mime] };
});
route('POST', '/api/student/submit', async (req, url) => {
  const { s, cls } = requireStudent(req, url);
  const b = await readJson(req);
  const n = Number(b.n);
  if (n !== recordableAttempt(stepOf(cls, s))) fail(409, '지금 단계와 맞지 않는 제출입니다. 화면을 새로고침하세요.');
  const ext = Object.values(EXT).includes(b.ext) ? b.ext : '';
  const tmp = path.join(TMP_DIR, String(b.uploadId || '').replace(/[^\w-]/g, '') + ext);
  if (!ext || !fs.existsSync(tmp)) fail(400, '녹음 파일을 찾을 수 없습니다. 다시 녹음하세요.');
  const safeAlias = s.alias.replace(/[^\w가-힣-]/g, '_');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const rel = path.join(cls.code, `${safeAlias}_${STEP_OF_ATTEMPT[n]}단계_${stamp}${ext}`);
  fs.mkdirSync(path.dirname(audioPath(rel)), { recursive: true });
  fs.renameSync(tmp, audioPath(rel));
  const live = str(b.transcript, 8000);
  const duration = Math.round(Number(b.durationSec) || 0);
  s.attempts['a' + n] = {
    n,
    step: STEP_OF_ATTEMPT[n],
    file: rel,
    mime: MIME[ext],
    bytes: fs.statSync(audioPath(rel)).size,
    sha256: sha256File(audioPath(rel)),
    durationSec: duration,
    liveTranscript: live,
    transcript: config.sttProvider === 'browser' ? live : '',
    transcriptSource: config.sttProvider === 'browser' ? 'browser' : '',
    transcriptHistory: live ? [{ at: Date.now(), source: 'browser', text: live }] : [],
    hiddenCount: Math.max(0, Number(b.hiddenCount) || 0),
    take: s.takes?.['a' + n] || 1,
    startedAt: Number(b.startedAt) || null,
    submittedAt: Date.now(),
    state: 'queued',
    error: '',
  };
  log(s, '구술 제출', `${ATTEMPT_LABEL[n]} · ${duration}초 · SHA-256 ${s.attempts['a' + n].sha256.slice(0, 12)}`);
  saveDbNow();
  enqueue(s.id, n);
  return { ok: true };
});
route('POST', '/api/student/retry', async (req, url) => {
  const { s } = requireStudent(req, url);
  const n = Number((await readJson(req)).n);
  const at = s.attempts['a' + n];
  if (!at || at.state !== 'error') fail(400, '다시 시도할 항목이 없습니다.');
  at.state = 'queued';
  enqueue(s.id, n);
  return { ok: true };
});
route('POST', '/api/student/objection', async (req, url) => {
  const { s } = requireStudent(req, url);
  if (!s.final?.published) fail(400, '최종 결과가 공개된 뒤에 이의를 제기할 수 있습니다.');
  const text = str((await readJson(req)).text, 2000);
  if (text.length < 10) fail(400, '이의제기 내용을 구체적으로(10자 이상) 적어 주세요.');
  if (s.objections.filter((o) => !o.reply).length) fail(400, '답변을 기다리는 이의제기가 이미 있습니다.');
  s.objections.push({ at: Date.now(), text, reply: '', repliedAt: null });
  log(s, '이의제기 접수', text.slice(0, 60));
  saveDbNow();
  return { ok: true };
});

// ───────────────────────── 정적 파일 ─────────────────────────
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
function serveStatic(url, res) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('페이지를 찾을 수 없습니다.');
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

async function handler(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'");
  res.setHeader('Permissions-Policy', 'microphone=(self)');
  const url = new URL(req.url, 'http://local');
  try {
    if (!url.pathname.startsWith('/api/')) return serveStatic(url, res);
    for (const r of routes) {
      const m = r.method === req.method && r.re.exec(url.pathname);
      if (!m) continue;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      const out = await r.handler(req, url, params, res);
      if (out === undefined) return; // 직접 응답함(음성 스트리밍)
      if (out.__raw !== undefined) {
        res.writeHead(200, { 'Content-Type': out.type, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(out.filename)}`, 'Cache-Control': 'no-store' });
        return res.end(out.__raw);
      }
      return send(res, 200, out);
    }
    send(res, 404, { error: '없는 기능입니다.' });
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    if (!res.headersSent) send(res, e.status || 500, { error: e instanceof HttpError ? e.message : '서버 오류: ' + e.message });
  }
}

// ───────────────────────── 서버 시작 ─────────────────────────
// 학생 기기에서 마이크를 쓰려면 브라우저가 HTTPS를 요구하므로, 교사 PC용 자체 서명 인증서를 만듭니다.
async function loadCert() {
  const file = path.join(DATA_DIR, 'cert.json');
  const ips = lanAddresses().map((a) => a.ip).sort();
  let saved = null;
  try {
    saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {}
  if (saved && JSON.stringify(saved.ips) === JSON.stringify(ips)) return saved;
  const pems = await generateCert([{ name: 'commonName', value: 'socratest-oral.local' }], {
    days: 825,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }, ...ips.map((ip) => ({ type: 7, ip }))] },
    ],
  });
  const cert = { key: pems.private, cert: pems.cert, ips };
  fs.writeFileSync(file, JSON.stringify(cert));
  return cert;
}

// 서버가 꺼졌을 때 처리 중이던 항목을 다시 대기열에 넣습니다.
for (const s of db.students) {
  for (const [k, at] of Object.entries(s.attempts)) if (['queued', 'transcribing', 'evaluating'].includes(at.state)) enqueue(s.id, Number(k.slice(1)));
}
// 오래된 임시 업로드 정리(하루 이상)
for (const f of fs.readdirSync(TMP_DIR)) {
  const fp = path.join(TMP_DIR, f);
  if (Date.now() - fs.statSync(fp).mtimeMs > 864e5) fs.rmSync(fp, { force: true });
}

const HOST = process.env.HOST || '127.0.0.1';
http.createServer(handler).listen(HTTP_PORT, HOST, () => {
  console.log('\n==============================================');
  console.log(' 국어 구술 수행평가 도우미가 실행되었습니다.');
  console.log(`  교사용(이 PC):   http://localhost:${HTTP_PORT}/teacher.html`);
  // 실행 파일(start-windows.bat 등)로 켰을 때 교사 화면을 자동으로 엽니다.
  if (process.env.OPEN_BROWSER) {
    const u = `http://localhost:${HTTP_PORT}/teacher.html`;
    const cmd = process.platform === 'win32' ? `start "" "${u}"` : process.platform === 'darwin' ? `open "${u}"` : `xdg-open "${u}"`;
    exec(cmd, () => {});
  }
}).on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `\n⚠ ${HTTP_PORT}번 포트를 이미 쓰고 있습니다. 프로그램이 이미 켜져 있는지 확인하세요.\n` : e);
  process.exit(1);
});
const cert = await loadCert();
https.createServer({ key: cert.key, cert: cert.cert }, handler).listen(HTTPS_PORT, '0.0.0.0', () => {
  for (const a of lanAddresses()) console.log(`  학생 접속 주소:  https://${a.ip}:${HTTPS_PORT}/student.html`);
  console.log('  이 창을 닫으면 프로그램이 종료됩니다.');
  console.log('==============================================\n');
});
process.on('SIGINT', () => {
  saveDbNow();
  process.exit(0);
});
