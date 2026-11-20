// 학생 화면: 단계별 구술 녹음 → AI 피드백 확인 → 다음 단계
const api = makeApi('studentToken');
let state = null;
let recorder = null;
let pollTimer = null;
let lastSig = '';

const STEP_TEXT = {
  1: { h: '1단계 · 1차 구술', p: '제시문을 읽고 구술 과제에 대한 자신의 생각을 말해 보세요. 메모를 보며 말해도 좋지만, 글을 그대로 읽기보다 자기 말로 설명해 주세요.' },
  3: { h: '3단계 · 수정 구술', p: '1차 피드백과 질문을 참고해 내용을 보완하여 다시 말해 보세요. 처음부터 끝까지 완성된 답변으로 말합니다.' },
  6: { h: '6단계 · 실전 최종 구술', p: '2차 피드백을 반영하여 최종 답변을 말해 주세요. 이 녹음이 실전 수행평가의 평가 자료가 됩니다.' },
};

// ── 입장 ──
const params = new URLSearchParams(location.search);
$('#code').value = (params.get('code') || storage('lastCode') || '').toUpperCase();
$('#alias').value = storage('lastAlias');
async function showClassInfo() {
  const code = $('#code').value.trim();
  if (code.length < 6) return ($('#classInfo').textContent = '');
  try {
    const j = await api('/api/join-info/' + encodeURIComponent(code));
    const phase = { practice: '수행 연습 중', assessment: '실전 수행평가 중', closed: '마감' }[j.phase];
    $('#classInfo').textContent = `▶ ${j.title} (${j.areaLabel}) · ${phase}`;
  } catch (e) {
    $('#classInfo').textContent = e.message;
  }
}
$('#code').addEventListener('input', showClassInfo);
showClassInfo();

$('#joinBtn').onclick = async () => {
  try {
    const code = $('#code').value.trim().toUpperCase();
    const alias = $('#alias').value.trim();
    const j = await api('/api/student/join', { body: { code, alias, pin: $('#pin').value.trim() } });
    storage('studentToken', j.token);
    storage('lastCode', code);
    storage('lastAlias', alias);
    $('#pin').value = '';
    load();
  } catch (e) {
    toast(e.message, 'error');
  }
};
$('#pin').addEventListener('keydown', (e) => e.key === 'Enter' && $('#joinBtn').click());
$('#logout').onclick = () => {
  if (recorder?.busy && !confirm('녹음 중입니다. 정말 나갈까요?')) return;
  storage('studentToken', null);
  location.href = '/student.html';
};

// ── 상태 불러오기·주기적 확인 ──
async function load() {
  clearTimeout(pollTimer);
  try {
    state = await api('/api/student/state');
  } catch (e) {
    if (e.status === 401) {
      storage('studentToken', null);
      $('#join').classList.remove('hidden');
      $('#app').classList.add('hidden');
      if (storage('lastAlias')) toast(e.message, 'error');
      return;
    }
    toast(e.message, 'error');
    pollTimer = setTimeout(load, 8000);
    return;
  }
  $('#join').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#logout').classList.remove('hidden');
  const sig = JSON.stringify([state.step, state.class.phase, state.attempts, Object.keys(state.evals), state.final, state.objections, state.takesUsed]);
  // 녹음 중이거나 화면 내용이 그대로면 다시 그리지 않습니다.
  if (sig !== lastSig && !recorder?.busy) {
    lastSig = sig;
    render();
  }
  const waiting = [2, 4, 7].includes(state.step) || Object.values(state.attempts).some((a) => a && a.state !== 'done');
  const delay = waiting ? 3000 : [5, 8].includes(state.step) ? 15000 : 30000;
  pollTimer = setTimeout(load, delay);
}

function render() {
  const s = state;
  const c = s.class;
  $('#who').textContent = s.alias;
  $('#title').textContent = c.title;
  $('#phasePill').innerHTML = {
    practice: '<span class="pill practice">수행 연습 1~5단계</span>',
    assessment: '<span class="pill exam">실전 수행평가 6~7단계</span>',
    closed: '<span class="pill gray">마감</span>',
  }[c.phase];
  $('#passage').textContent = c.passage;
  $('#task').textContent = c.task;
  $('#rubric').innerHTML = c.rubric.map((r) => `<tr><th>${esc(r.name)} (${r.points}점)${r.teacherOnly ? ' <span class="pill gray">선생님 채점</span>' : ''}</th><td>${esc(r.desc)}</td></tr>`).join('');
  const now = s.step === 9 ? 9 : s.step;
  $('#stepper').innerHTML = STAGES.map((st) => {
    const cls = st.phase === '연습' ? 'practice' : st.phase === '실전' ? 'exam' : 'teacher';
    const done = isDone(st.n);
    return `<div class="${cls} ${done ? 'done' : ''} ${st.n === now ? 'now' : ''}"><b>${st.n}</b>${st.name}</div>`;
  }).join('');
  renderStage();
  renderHistory();
}
function isDone(n) {
  const { attempts: A, evals: E, final } = state;
  return { 1: A.a1, 2: E.e1, 3: A.a2, 4: E.e2, 5: E.e2, 6: A.a3, 7: E.e3 || (A.a3?.state === 'done'), 8: final }[n];
}

function processingCard(n) {
  const at = state.attempts['a' + n];
  if (at?.state === 'error') {
    return `<p class="danger-box">처리 중 문제가 생겼어요: ${esc(at.error)}</p><button id="retryBtn">다시 시도</button> <span class="hint">녹음은 안전하게 저장되어 있어요.</span>`;
  }
  if (at?.state === 'needs_transcript') return `<p class="warn">${esc(at.error)}</p><p class="muted">녹음은 안전하게 저장되어 있어요. 잠시 기다려 주세요.</p>`;
  const label = { queued: '차례를 기다리는 중', transcribing: '음성을 글로 바꾸는 중', evaluating: 'AI가 답변을 분석하는 중' }[at?.state] || '처리 중';
  return `<p><span class="spinner"></span> ${label}… (보통 30초~1분)</p><p class="muted">이 화면을 그대로 두면 결과가 나오면 자동으로 바뀌어요.</p>`;
}

function renderStage() {
  const s = state;
  const el = $('#stage');
  recorder = null;
  const E = s.evals;
  const n = s.step;
  let html = '';
  if (n === 0) html = '<h2>수업이 마감되었습니다</h2><p>아래에서 내 기록을 확인할 수 있어요.</p>';
  if (n === 1) html = `<h2>${STEP_TEXT[1].h}</h2><p>${STEP_TEXT[1].p}</p><div id="rec"></div>`;
  if (n === 2) html = `<h2>2단계 · AI 평가와 1차 피드백</h2>${processingCard(1)}`;
  if (n === 3) html = `<h2>${STEP_TEXT[3].h}</h2>${evalCard(E.e1, { title: '1차 피드백' })}<p>${STEP_TEXT[3].p}</p><div id="rec"></div>`;
  if (n === 4) html = `<h2>4단계 · 수정 구술 AI 평가</h2>${processingCard(2)}`;
  if (n === 5)
    html = `<h2>5단계 · 2차 피드백</h2>${evalCard(E.e2, { title: '2차 피드백' })}
      <p class="note">수행 연습을 모두 마쳤어요. 2차 피드백을 정리해 두세요. 선생님이 <b>실전 수행평가</b>를 시작하면 6단계로 넘어갑니다.</p>`;
  if (n === 6) {
    const left = s.class.assessmentTakes - s.takesUsed;
    html = `<h2>${STEP_TEXT[6].h}</h2>
      ${E.e2 ? evalCard(E.e2, { title: '반영할 2차 피드백' }) : '<p class="warn">수행 연습 기록이 없습니다. 바로 실전 구술을 진행합니다.</p>'}
      <p>${STEP_TEXT[6].p}</p><div id="rec"></div>
      ${left <= 0 ? '<p class="danger-box">녹음 기회를 모두 사용했어요. 기기 문제라면 선생님께 말씀하세요.</p>' : ''}`;
  }
  if (n === 7) html = `<h2>7단계 · AI 평가</h2>${processingCard(3)}`;
  if (n === 8)
    html = `<h2>제출 완료 · 선생님 최종 확인 중</h2>
      <p>실전 구술이 제출되었습니다. 선생님이 녹음과 AI 평가를 검토한 뒤 최종 피드백을 공개합니다.</p>
      ${E.e3 ? evalCard(E.e3, { title: 'AI 평가(선생님 확정 전 잠정 결과)' }) : ''}`;
  if (n === 9) html = finalHtml();
  el.innerHTML = html;

  const retry = $('#retryBtn');
  if (retry) retry.onclick = async () => {
    const at = Object.values(s.attempts).find((a) => a?.state === 'error');
    try {
      await api('/api/student/retry', { body: { n: at.n } });
      load();
    } catch (e) {
      toast(e.message, 'error');
    }
  };
  if (s.recordFor && $('#rec')) {
    const attemptN = s.recordFor;
    const assessment = attemptN === 3;
    recorder = new OralRecorder($('#rec'), {
      maxSeconds: s.class.maxSeconds,
      browserStt: s.class.sttProvider === 'browser',
      assessment,
      takesLeft: assessment ? s.class.assessmentTakes - s.takesUsed : 99,
      onBeforeStart: () => api('/api/student/record-start', { body: {} }),
      onSubmit: async (r) => {
        const up = await api('/api/student/audio', { raw: { blob: r.blob, type: r.blob.type || 'audio/webm' } });
        await api('/api/student/submit', { body: { n: attemptN, uploadId: up.uploadId, ext: up.ext, transcript: r.transcript, durationSec: r.durationSec, hiddenCount: r.hiddenCount, startedAt: r.startedAt } });
        toast('제출했어요!', 'ok');
        recorder = null;
        lastSig = '';
        load();
      },
    });
  }
  const objBtn = $('#objBtn');
  if (objBtn) objBtn.onclick = async () => {
    try {
      await api('/api/student/objection', { body: { text: $('#objText').value } });
      toast('이의제기를 접수했어요.', 'ok');
      lastSig = '';
      load();
    } catch (e) {
      toast(e.message, 'error');
    }
  };
}

function finalHtml() {
  const s = state;
  const f = s.final;
  const rows = s.class.rubric.map((r) => `<tr><th>${esc(r.name)}</th><td class="num">${f.scores[r.name] ?? '-'} / ${r.points}</td></tr>`).join('');
  const pending = s.objections.some((o) => !o.reply);
  return `<h2>최종 결과</h2>
    <p><span class="pill exam">최종 점수 ${f.total} / ${f.max}</span> <span class="muted">${fmtTime(f.publishedAt)} 공개</span></p>
    <table class="rubric-table">${rows}</table>
    <h3>선생님 최종 피드백</h3><div class="feedback-box">${nl(f.feedback)}</div>
    ${s.evals.e3 ? `<details><summary>AI 잠정 평가 보기(참고용)</summary>${evalCard(s.evals.e3)}</details>` : ''}
    <h3>이의제기</h3>
    ${s.objections.map((o) => `<div class="note"><b>${fmtTime(o.at)} 내 의견</b><br>${nl(o.text)}${o.reply ? `<hr><b>선생님 답변 (${fmtTime(o.repliedAt)})</b><br>${nl(o.reply)}` : '<br><span class="muted">답변을 기다리는 중</span>'}</div>`).join('')}
    ${
      pending
        ? ''
        : `<p class="hint">점수나 피드백에 의문이 있으면 구체적인 이유(어느 기준, 녹음의 어느 부분)를 적어 주세요. 선생님이 녹음 원본을 다시 확인합니다.</p>
           <textarea id="objText" maxlength="2000" placeholder="예: '근거 활용' 기준에서 저는 2연의 시어를 인용해 설명했는데 반영되지 않은 것 같습니다."></textarea>
           <button id="objBtn" class="secondary">이의제기 제출</button>`
    }`;
}

function renderHistory() {
  const s = state;
  const t = encodeURIComponent(storage('studentToken'));
  const items = [
    [1, '1차 구술 (1단계)', s.evals.e1, '1차 피드백'],
    [2, '수정 구술 (3단계)', s.evals.e2, '2차 피드백'],
    [3, '실전 최종 구술 (6단계)', s.evals.e3, 'AI 평가'],
  ]
    .filter(([n]) => s.attempts['a' + n])
    .map(([n, label, ev, evLabel]) => {
      const at = s.attempts['a' + n];
      return `<div class="attempt ${n === 3 ? 'exam' : ''}">
        <h3>${label}</h3>
        <p class="kv">${fmtTime(at.submittedAt)} 제출 · ${fmtSec(at.durationSec)}</p>
        <audio controls preload="none" src="/api/audio/${s.id}/a${n}?t=${t}"></audio>
        <details><summary>전사문 보기</summary><p>${nl(at.transcript || '(아직 전사되지 않음)')}</p></details>
        ${ev && n < 3 && s.step > (n === 1 ? 3 : 5) ? `<details><summary>${evLabel} 다시 보기</summary>${evalCard(ev)}</details>` : ''}
      </div>`;
    });
  $('#history').innerHTML = items.length ? `<h2>내 기록</h2>${items.join('')}` : '<h2>내 기록</h2><p class="muted">아직 제출한 구술이 없어요.</p>';
}

window.addEventListener('beforeunload', (e) => {
  if (recorder?.busy) {
    e.preventDefault();
    e.returnValue = '';
  }
});

if (storage('studentToken')) load();
