// 인증: 교사 비밀번호는 scrypt 해시로만 저장하고, 접속 토큰은 서명(HMAC) 방식이라
// 서버(교사 PC)를 껐다 켜도 학생·교사가 다시 로그인하지 않아도 됩니다.
import crypto from 'node:crypto';
import { config, saveConfig } from './store.js';

const TEACHER_TTL = 12 * 3600e3; // 교사 12시간
const STUDENT_TTL = 30 * 24 * 3600e3; // 학생 30일(연습 → 실전 사이 기간 고려)

export function hashPassword(pw, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(pw), salt, 64).toString('hex');
  return { salt, hash };
}

export function setTeacherPassword(pw) {
  const { salt, hash } = hashPassword(pw);
  config.passwordSalt = salt;
  config.passwordHash = hash;
  // 비밀번호를 바꾸면 기존 교사 토큰은 모두 무효가 되도록 세대 번호를 올립니다.
  config.teacherGen = (config.teacherGen || 0) + 1;
  saveConfig();
}

export function checkTeacherPassword(pw) {
  if (!config.passwordHash) return false;
  const { hash } = hashPassword(pw, config.passwordSalt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(config.passwordHash, 'hex'));
}

function sign(body) {
  return crypto.createHmac('sha256', config.tokenSecret).update(body).digest('base64url');
}

export function makeToken(payload) {
  const body = Buffer.from(JSON.stringify({ ...payload, iat: Date.now() })).toString('base64url');
  return body + '.' + sign(body);
}

export function readToken(token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const expected = sign(body);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    const ttl = p.role === 'teacher' ? TEACHER_TTL : STUDENT_TTL;
    if (Date.now() - p.iat > ttl) return null;
    if (p.role === 'teacher' && p.gen !== (config.teacherGen || 0)) return null;
    return p;
  } catch {
    return null;
  }
}

export const teacherToken = () => makeToken({ role: 'teacher', gen: config.teacherGen || 0 });
export const studentToken = (id) => makeToken({ role: 'student', id });

// 교사 비밀번호 무작위 대입 방지: 같은 주소에서 5회 틀리면 1분간 잠금
const fails = new Map();
export function loginBlocked(ip) {
  const f = fails.get(ip);
  return f && f.count >= 5 && Date.now() - f.at < 60e3;
}
export function loginFailed(ip) {
  const f = fails.get(ip) || { count: 0, at: 0 };
  if (Date.now() - f.at > 60e3) f.count = 0;
  f.count++;
  f.at = Date.now();
  fails.set(ip, f);
}
export const loginOk = (ip) => fails.delete(ip);

// 학생 재접속용 4자리 PIN
export function hashPin(pin, salt) {
  return crypto.scryptSync(String(pin), salt, 32).toString('hex');
}
