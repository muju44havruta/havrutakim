// GitHub Pages용 docs/ 폴더를 만듭니다: node web/build.mjs
//  docs/teacher.html  교사용(제시문 등록 → 학생 링크·QR·HTML 파일)
//  docs/student.html  학생용(링크의 #c= 또는 내장 수업 정보로 동작) = lib/standalone-template.html
//  docs/index.html    안내
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AREAS } from '../lib/rubrics.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, '../../docs');
fs.mkdirSync(out, { recursive: true });
const areas = Object.fromEntries(Object.entries(AREAS).map(([k, v]) => [k, { label: v.label, task: v.task, rubric: v.rubric }]));
const template = fs.readFileSync(path.resolve(here, '../lib/standalone-template.html'), 'utf8');
const teacher = fs
  .readFileSync(path.join(here, 'teacher-src.html'), 'utf8')
  .replace(/\/\*__AREAS__\*\/[\s\S]*?\/\*__END__\*\//, () => JSON.stringify(areas))
  .replace(/\/\*__TEMPLATE__\*\/[\s\S]*?\/\*__END2__\*\//, () => JSON.stringify(template).replace(/<\//g, '<\\/'));
fs.writeFileSync(path.join(out, 'teacher.html'), teacher);
fs.copyFileSync(path.resolve(here, '../lib/standalone-template.html'), path.join(out, 'student.html'));
fs.copyFileSync(path.join(here, 'index.html'), path.join(out, 'index.html'));
fs.copyFileSync(path.join(here, 'qrcode.min.js'), path.join(out, 'qrcode.min.js')); // MIT, Ryan Day (npm qrcode)
console.log('docs/ 생성 완료:', fs.readdirSync(out).join(', '));
