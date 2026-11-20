// 데이터 저장소: 교사 PC의 data/ 폴더에 JSON 파일과 음성 파일을 보관합니다.
// - data/config.json : 교사 비밀번호(해시), API 키, AI 설정
// - data/db.json     : 수업·학생·평가 기록
// - data/audio/      : 학생 녹음 파일(이의제기 대응용 원본 증빙)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const DATA_DIR = process.env.DATA_DIR || path.resolve('data');
export const AUDIO_DIR = path.join(DATA_DIR, 'audio');
export const TMP_DIR = path.join(DATA_DIR, 'tmp');
for (const d of [DATA_DIR, AUDIO_DIR, TMP_DIR]) fs.mkdirSync(d, { recursive: true });

const DB_FILE = path.join(DATA_DIR, 'db.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// 쓰기는 임시 파일에 먼저 기록한 뒤 이름을 바꿔, 저장 도중 꺼져도 파일이 깨지지 않게 합니다.
function writeJson(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
  fs.renameSync(tmp, file);
}

export const db = readJson(DB_FILE, { classes: [], students: [] });
db.classes ??= [];
db.students ??= [];

export const config = readJson(CONFIG_FILE, {});
config.tokenSecret ??= crypto.randomBytes(32).toString('hex');
config.model ??= 'claude-opus-5-5';
config.effort ??= 'medium';
config.sttProvider ??= 'browser';
config.openaiSttModel ??= 'gpt-4o-mini-transcribe';
config.mock ??= false;
writeJson(CONFIG_FILE, config);

let saveTimer = null;
// 짧은 시간에 여러 번 바뀌어도 한 번만 저장합니다(최대 0.3초 지연).
export function saveDb() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    writeJson(DB_FILE, db);
  }, 300);
}
export function saveDbNow() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  writeJson(DB_FILE, db);
}
export function saveConfig() {
  writeJson(CONFIG_FILE, config);
}

export const findClass = (code) => db.classes.find((c) => c.code === String(code || '').toUpperCase());
export const findStudent = (id) => db.students.find((s) => s.id === id);
export const studentsOf = (code) => db.students.filter((s) => s.classCode === code);

export function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
