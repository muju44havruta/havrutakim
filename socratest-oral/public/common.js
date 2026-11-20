// 교사·학생 화면 공통 도우미
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const nl = (s) => esc(s).replace(/\n/g, '<br>');
const fmtTime = (t) => (t ? new Date(t).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
const fmtSec = (s) => `${Math.floor((s || 0) / 60)}분 ${String((s || 0) % 60).padStart(2, '0')}초`;

function storage(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key) || '';
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    return '';
  }
}

function makeApi(tokenKey) {
  return async function api(url, { method, body, raw } = {}) {
    const headers = { Authorization: 'Bearer ' + storage(tokenKey) };
    let payload;
    if (raw) {
      headers['Content-Type'] = raw.type;
      payload = raw.blob;
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const r = await fetch(url, { method: method || (payload ? 'POST' : 'GET'), headers, body: payload });
    const j = await r.json().catch(() => ({ error: '서버 응답을 읽지 못했습니다.' }));
    if (!r.ok) {
      const err = new Error(j.error || '오류가 발생했습니다.');
      err.status = r.status;
      throw err;
    }
    return j;
  };
}

let toastTimer;
function toast(msg, kind = 'info') {
  let el = $('#toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.setAttribute('role', 'status');
    document.body.append(el);
  }
  el.textContent = msg;
  el.className = 'show ' + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = ''), kind === 'error' ? 6000 : 3000);
}

const STAGES = [
  { n: 1, phase: '연습', name: '1차 구술' },
  { n: 2, phase: '연습', name: 'AI 평가·1차 피드백' },
  { n: 3, phase: '연습', name: '수정 구술' },
  { n: 4, phase: '연습', name: 'AI 수정 평가' },
  { n: 5, phase: '연습', name: 'AI 2차 피드백' },
  { n: 6, phase: '실전', name: '최종 구술' },
  { n: 7, phase: '실전', name: 'AI 평가·피드백' },
  { n: 8, phase: '교사', name: '교사 최종 피드백' },
];

// AI 평가 결과 카드(교사·학생 공용). teacher=true면 교사용 메모까지 표시
function evalCard(r, { title, teacher = false, showScores = true } = {}) {
  if (!r) return '';
  const li = (arr) => (arr?.length ? `<ul>${arr.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '');
  const rows = r.criteria
    .map(
      (c) => `<tr><th>${esc(c.name)}</th>${showScores ? `<td class="num">${c.score}/${c.points}</td>` : ''}<td>${esc(c.comment)}${c.evidence ? `<div class="quote">${esc(c.evidence)}</div>` : ''}</td></tr>`,
    )
    .join('');
  return `<div class="eval">
    ${title ? `<h4>${esc(title)}${showScores ? ` <span class="pill">AI ${r.aiTotal}/${r.aiMax}</span>` : ''}</h4>` : ''}
    <div class="feedback-box">${nl(r.studentFeedback)}</div>
    ${r.questions?.length ? `<div class="questions"><b>생각해 볼 질문</b>${li(r.questions)}</div>` : ''}
    ${r.comparison && r.comparison !== '해당 없음' ? `<p><b>이전과 비교</b> ${esc(r.comparison)} ${r.feedbackApplied && r.feedbackApplied !== '해당없음' ? `<span class="pill">${esc(r.feedbackApplied)}</span>` : ''}</p>` : ''}
    <details ${teacher ? 'open' : ''}><summary>기준별 평가 보기</summary>
      <table class="rubric-table">${rows}</table>
      ${r.strengths?.length ? `<p><b>잘한 점</b></p>${li(r.strengths)}` : ''}
      ${r.improvements?.length ? `<p><b>보완할 점</b></p>${li(r.improvements)}` : ''}
      ${teacher ? `<p><b>종합</b> ${esc(r.summary)}</p>` : ''}
    </details>
    ${teacher && r.transcriptIssues ? `<p class="warn">전사 확인 필요: ${esc(r.transcriptIssues)}</p>` : ''}
    ${teacher && r.teacherNote ? `<p class="note">교사 참고: ${esc(r.teacherNote)}</p>` : ''}
  </div>`;
}
