// 교사 화면
const api = makeApi('teacherToken');
let areas = {};
let currentCode = '';
let editingCode = null;
let classData = null; // { class, students, queue }
let selectedId = '';
let detailDirty = false;
let pollTimer = null;
let lastDetailSig = '';

const PHASE_LABEL = {
  practice: '<span class="pill practice">수행 연습 1~5단계</span>',
  assessment: '<span class="pill exam">실전 수행평가 6~7단계</span>',
  closed: '<span class="pill gray">마감</span>',
};
const STEP_BADGE = {
  0: '<span class="pill gray">마감</span>',
  1: '<span class="pill gray">1 대기</span>',
  2: '<span class="pill warn">2 AI 분석</span>',
  3: '<span class="pill practice">3 수정 구술</span>',
  4: '<span class="pill warn">4 AI 분석</span>',
  5: '<span class="pill practice">5 연습 완료</span>',
  6: '<span class="pill exam">6 실전 대기</span>',
  7: '<span class="pill warn">7 AI 분석</span>',
  8: '<span class="pill exam">교사 확정 필요</span>',
  9: '<span class="pill">공개 완료</span>',
};
const SOURCE = { browser: '브라우저 음성 인식', openai: 'OpenAI 음성 인식', teacher: '교사 수정', mock: '모의', '': '전사 전' };

function show(view) {
  for (const v of ['setup', 'login', 'list', 'editor', 'class', 'settings']) $('#v-' + v).classList.toggle('hidden', v !== view);
  $('#nav').classList.toggle('hidden', ['setup', 'login'].includes(view));
  $('#logoutBtn').classList.toggle('hidden', ['setup', 'login'].includes(view));
  if (view !== 'class') clearTimeout(pollTimer);
  window.scrollTo(0, 0);
}

// ── 시작 ──
async function boot() {
  const st = await api('/api/status');
  if (!st.setupDone) {
    if (!st.isLocal) {
      show('login');
      $('#v-login').innerHTML = '<h2>최초 설정 필요</h2><p>교사 PC에서 <code>http://localhost:3000/teacher.html</code>을 열어 비밀번호를 먼저 정하세요.</p>';
      return;
    }
    return show('setup');
  }
  if (!storage('teacherToken')) return show('login');
  try {
    areas = await api('/api/areas');
    await renderBadge();
    await openList();
  } catch (e) {
    if (e.status === 401) return show('login');
    toast(e.message, 'error');
  }
}
async function renderBadge() {
  const s = await api('/api/settings');
  $('#aiBadge').innerHTML = s.mock ? '<span class="pill warn">모의 AI 모드</span>' : s.anthropicKey ? '' : '<span class="pill warn">Claude 키 미설정</span>';
}

$('#setupBtn').onclick = async () => {
  if ($('#setupPw').value !== $('#setupPw2').value) return toast('비밀번호 확인이 일치하지 않습니다.', 'error');
  try {
    const j = await api('/api/setup', { body: { password: $('#setupPw').value } });
    storage('teacherToken', j.token);
    toast('설정 완료! 다음으로 Claude API 키를 입력하세요.', 'ok');
    areas = await api('/api/areas');
    openSettings();
  } catch (e) {
    toast(e.message, 'error');
  }
};
$('#loginBtn').onclick = async () => {
  try {
    const j = await api('/api/teacher/login', { body: { password: $('#loginPw').value } });
    storage('teacherToken', j.token);
    $('#loginPw').value = '';
    boot();
  } catch (e) {
    toast(e.message, 'error');
  }
};
$('#loginPw').addEventListener('keydown', (e) => e.key === 'Enter' && $('#loginBtn').click());
$('#logoutBtn').onclick = () => {
  storage('teacherToken', null);
  location.reload();
};
$$('[data-go]').forEach((b) => (b.onclick = () => (b.dataset.go === 'list' ? openList() : openSettings())));

// ── 수업 목록 ──
async function openList() {
  show('list');
  const list = await api('/api/classes');
  $('#classList').innerHTML = list.length
    ? list
        .map(
          (c) => `<div class="attempt ${c.phase === 'assessment' ? 'exam' : ''}">
        <div class="row"><b>${esc(c.title)}</b> ${PHASE_LABEL[c.phase]} <span class="pill gray">${esc(c.areaLabel)}</span> <span class="pill">코드 ${c.code}</span></div>
        <p class="kv">학생 ${c.count}명 · 연습 완료 ${c.practiceDone} · 실전 제출·평가 ${c.assessmentDone} · 최종 공개 ${c.published}${c.objectionsOpen ? ` · <b style="color:var(--exam)">미답변 이의제기 ${c.objectionsOpen}건</b>` : ''} · ${fmtTime(c.created)} 생성</p>
        <button class="small" data-open="${c.code}">열기</button>
      </div>`,
        )
        .join('')
    : '<p class="muted">아직 수업이 없습니다. "새 수업 만들기"로 시작하세요.</p>';
  $$('[data-open]').forEach((b) => (b.onclick = () => openClass(b.dataset.open)));
}
$('#newClassBtn').onclick = () => openEditor(null);

// ── 수업 만들기·편집 ──
function fillArea(force) {
  const a = areas[$('#f-area').value];
  if (!a) return;
  if (force || !$('#f-task').value.trim()) $('#f-task').value = a.task;
  if (force || !$('#f-rubric').value.trim()) $('#f-rubric').value = a.rubricText;
  rubricSum();
}
function rubricSum() {
  const lines = $('#f-rubric').value.split('\n').filter((l) => l.trim());
  const total = lines.reduce((s, l) => s + (Number(l.split('|')[1]) || 0), 0);
  const teacher = lines.filter((l) => /교사\s*$/.test(l)).length;
  $('#rubricSum').textContent = `기준 ${lines.length}개 · 총 ${total}점${teacher ? ` · 교사 직접 채점 ${teacher}개` : ''}`;
}
$('#f-rubric').addEventListener('input', rubricSum);
const SAMPLE_POEM = {
  title: '김소월 「진달래꽃」 구술 평가',
  passage: '진달래꽃\n\n김소월\n\n나 보기가 역겨워\n가실 때에는\n말없이 고이 보내 드리우리다\n\n영변에 약산\n진달래꽃\n아름 따다 가실 길에 뿌리우리다\n\n가시는 걸음걸음\n놓인 그 꽃을\n사뿐히 즈려밟고 가시옵소서\n\n나 보기가 역겨워\n가실 때에는\n죽어도 아니 눈물 흘리우리다',
  task: '이 시의 화자가 처한 상황과 정서를 설명하고, 그렇게 판단한 근거가 되는 시어나 구절을 들어 말해 보세요. 특히 마지막 연의 "죽어도 아니 눈물 흘리우리다"에 담긴 화자의 진심을 어떻게 해석할 수 있는지 자신의 생각을 밝혀 보세요.',
};
const passageCount = () => ($('#pcount').textContent = `${$('#f-passage').value.length}자 · ${$('#f-passage').value.split('\n').length}줄`);
$('#f-passage').addEventListener('input', passageCount);
$('#sampleBtn').onclick = () => {
  if (($('#f-passage').value.trim() || $('#f-title').value.trim()) && !confirm('지금 입력한 제목·제시문·과제를 예시로 바꿀까요?')) return;
  $('#f-area').value = 'poetry';
  $('#f-rubric').value = areas.poetry.rubricText;
  $('#f-title').value = SAMPLE_POEM.title;
  $('#f-passage').value = SAMPLE_POEM.passage;
  $('#f-task').value = SAMPLE_POEM.task;
  passageCount();
  rubricSum();
};
$('#f-area').addEventListener('change', () => {
  const touched = $('#f-task').value.trim() || $('#f-rubric').value.trim();
  if (!touched || confirm('이 영역의 기본 구술 과제와 평가 기준으로 바꿀까요? (지금 입력한 과제·기준은 바뀝니다)')) fillArea(true);
});
function openEditor(c) {
  editingCode = c?.code || null;
  $('#editorTitle').textContent = c ? '수업 설정 편집' : '새 수업 만들기';
  $('#f-area').innerHTML = Object.entries(areas).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('');
  $('#f-area').value = c?.area || 'poetry';
  $('#f-title').value = c?.title || '';
  $('#f-passage').value = c?.passage || '';
  $('#f-task').value = c?.task || '';
  $('#f-standard').value = c?.standard || '';
  $('#f-rubric').value = c?.rubricText || '';
  $('#f-max').value = String(c?.maxSeconds || 180);
  $('#f-takes').value = String(c?.assessmentTakes || 1);
  $('#f-showai').checked = !!c?.showAiInAssessment;
  $('#f-email').value = c?.teacherEmail || '';
  if (!c) fillArea(false);
  rubricSum();
  passageCount();
  show('editor');
}
$('#cancelEditBtn').onclick = () => (editingCode ? openClass(editingCode) : openList());
$('#saveClassBtn').onclick = async () => {
  const body = {
    area: $('#f-area').value,
    title: $('#f-title').value,
    passage: $('#f-passage').value,
    task: $('#f-task').value,
    standard: $('#f-standard').value,
    rubricText: $('#f-rubric').value,
    maxSeconds: Number($('#f-max').value),
    assessmentTakes: Number($('#f-takes').value),
    showAiInAssessment: $('#f-showai').checked,
    teacherEmail: $('#f-email').value.trim(),
  };
  try {
    if (editingCode && classData?.students.some((s) => Object.keys(s.evals).length) && !confirm('이미 AI 평가를 받은 학생이 있습니다. 평가 기준을 바꾸면 이전 평가와 기준이 달라질 수 있습니다. 저장할까요?')) return;
    const c = editingCode ? await api('/api/classes/' + editingCode, { method: 'PUT', body }) : await api('/api/classes', { body });
    toast('저장했습니다.', 'ok');
    openClass(c.code);
  } catch (e) {
    toast(e.message, 'error');
  }
};

// ── 수업 화면 ──
async function openClass(code) {
  currentCode = code;
  selectedId = '';
  detailDirty = false;
  lastDetailSig = '';
  show('class');
  switchTab('students');
  await refreshClass();
}
async function refreshClass() {
  clearTimeout(pollTimer);
  try {
    classData = await api(`/api/classes/${currentCode}/students`);
  } catch (e) {
    toast(e.message, 'error');
    if (e.status === 401) return show('login');
  }
  if (!classData) return;
  const c = classData.class;
  $('#c-title').textContent = c.title;
  $('#c-code').textContent = '수업 코드 ' + c.code;
  $('#c-meta').textContent = `${c.areaLabel} · 학생 ${c.count}명 · 녹음 최대 ${fmtSec(c.maxSeconds)} · 실전 녹음 기회 ${c.assessmentTakes}회 · 실전 AI 결과 학생 공개: ${c.showAiInAssessment ? '즉시' : '교사 공개 시'}`;
  $$('#phaseSwitch button').forEach((b) => b.classList.toggle('on', b.dataset.phase === c.phase));
  $('#queueInfo').textContent = classData.queue ? `AI 처리 대기 ${classData.queue}건` : '';
  renderTable();
  if (selectedId) renderDetail(false);
  if (!$('#v-class').classList.contains('hidden')) pollTimer = setTimeout(refreshClass, 5000);
}
$('#editClassBtn').onclick = () => openEditor(classData.class);
$$('#phaseSwitch button').forEach(
  (b) =>
    (b.onclick = async () => {
      const phase = b.dataset.phase;
      if (phase === classData.class.phase) return;
      const msg = {
        practice: '수행 연습(1~5단계)으로 전환합니다. 학생은 1차 구술부터 진행합니다.',
        assessment: '실전 수행평가(6~7단계)를 시작합니다. 학생 화면이 최종 구술 단계로 바뀝니다. 연습을 마치지 못한 학생도 바로 실전에 들어갑니다.',
        closed: '수업을 마감합니다. 학생은 더 이상 녹음할 수 없고 기록만 볼 수 있습니다.',
      }[phase];
      if (!confirm(msg + '\n계속할까요?')) return;
      try {
        await api('/api/classes/' + currentCode, { method: 'PUT', body: { phase } });
        toast('진행 모드를 바꿨습니다.', 'ok');
        refreshClass();
      } catch (e) {
        toast(e.message, 'error');
      }
    }),
);
function switchTab(tab) {
  $$('#classTabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  for (const t of ['students', 'join', 'offline', 'export']) $('#t-' + t).classList.toggle('hidden', t !== tab);
  if (tab === 'join') renderJoin();
  if (tab === 'offline') $('#offEmail').textContent = classData?.class.teacherEmail || '(아직 등록 안 됨)';
  if (tab === 'export') renderExport();
}
$$('#classTabs button').forEach((b) => (b.onclick = () => switchTab(b.dataset.tab)));

function renderTable() {
  const ai = (e) => (e ? `${e.result.aiTotal}` : '');
  const rows = classData.students
    .map((s) => {
      const err = Object.values(s.attempts).some((a) => ['error', 'needs_transcript'].includes(a.state));
      const obj = s.objections.filter((o) => !o.reply).length;
      return `<tr data-id="${s.id}" class="${s.id === selectedId ? 'sel' : ''}">
      <td>${esc(s.alias)}</td><td>${STEP_BADGE[s.step]}${err ? ' <span class="pill exam">확인 필요</span>' : ''}</td>
      <td class="num">${ai(s.evals.e1)}</td><td class="num">${ai(s.evals.e2)}</td><td class="num">${ai(s.evals.e3)}</td>
      <td class="num">${s.final ? s.final.total : ''}${obj ? ' <span class="pill exam">이의</span>' : ''}</td></tr>`;
    })
    .join('');
  $('#studentTable').innerHTML = `<thead><tr><th>식별명</th><th>단계</th><th class="num">1차</th><th class="num">수정</th><th class="num">실전</th><th class="num">최종</th></tr></thead><tbody>${rows || '<tr><td colspan="6" class="muted">아직 입장한 학생이 없습니다.</td></tr>'}</tbody>`;
  $$('#studentTable tbody tr[data-id]').forEach(
    (tr) =>
      (tr.onclick = () => {
        if (detailDirty && !confirm('저장하지 않은 입력이 있습니다. 다른 학생으로 이동할까요?')) return;
        selectedId = tr.dataset.id;
        detailDirty = false;
        renderTable();
        renderDetail(true);
      }),
  );
}

// ── 학생 상세 ──
function renderDetail(force) {
  const s = classData.students.find((x) => x.id === selectedId);
  if (!s) return ($('#detail').innerHTML = '<p class="muted">왼쪽에서 학생을 선택하세요.</p>');
  const sig = JSON.stringify([s.attempts, Object.keys(s.evals).map((k) => s.evals[k].at), s.final, s.objections, s.archive.length]);
  if (!force && sig !== lastDetailSig && detailDirty) {
    // 입력 중에는 화면을 덮어쓰지 않고, 새 결과가 왔다는 알림만 보여 줍니다.
    if (!$('#freshNotice')) {
      $('#detail').insertAdjacentHTML('afterbegin', '<p class="warn" id="freshNotice">새 결과(녹음·AI 평가)가 도착했습니다. <button class="small" id="freshBtn">입력 내용 버리고 다시 불러오기</button></p>');
      $('#freshBtn').onclick = () => {
        detailDirty = false;
        renderDetail(true);
      };
    }
    return;
  }
  if (!force && sig === lastDetailSig) return;
  lastDetailSig = sig;
  const c = classData.class;
  const t = encodeURIComponent(storage('teacherToken'));
  const block = (n, label, exam) => {
    const at = s.attempts['a' + n];
    const ev = s.evals['e' + n];
    if (!at) return `<div class="attempt ${exam ? 'exam' : ''}"><h3>${label}</h3><p class="muted">아직 제출하지 않았습니다.</p></div>`;
    const stateMsg = {
      queued: '<span class="spinner"></span> 처리 대기',
      transcribing: '<span class="spinner"></span> 음성 인식 중',
      evaluating: '<span class="spinner"></span> AI 평가 중',
      error: `<span class="danger-box">오류: ${esc(at.error)}</span>`,
      needs_transcript: `<span class="warn">${esc(at.error)}</span>`,
      done: '',
    }[at.state];
    return `<div class="attempt ${exam ? 'exam' : ''}">
      <h3>${label}</h3>
      <p class="kv">${fmtTime(at.submittedAt)} 제출 · ${fmtSec(at.durationSec)} · ${at.take}번째 녹음${at.hiddenCount ? ` · <b>녹음 중 화면 이탈 ${at.hiddenCount}회</b>` : ''} · 전사: ${SOURCE[at.transcriptSource] || at.transcriptSource}${at.via === 'standalone' ? ' · <span class="pill gray">독립형 제출</span>' : ''}${at.source === 'file' ? ' · <span class="pill warn">녹음 파일 첨부(화면 녹음 아님)</span>' : ''}<br>
      SHA-256 <code>${at.sha256.slice(0, 16)}…</code> · ${Math.round(at.bytes / 1024)}KB</p>
      ${at.kind === 'video' ? `<video controls playsinline preload="metadata" style="width:100%;max-height:420px;background:#000;border-radius:10px" src="/api/audio/${s.id}/a${n}?t=${t}"></video>` : `<audio controls preload="none" src="/api/audio/${s.id}/a${n}?t=${t}"></audio>`}
      <p class="row"><a class="btn small secondary" href="/api/audio/${s.id}/a${n}?t=${t}&download=1">녹음 파일 저장</a></p>
      ${stateMsg ? `<p>${stateMsg}</p>` : ''}
      <label>전사문 <small>녹음을 들으며 인식 오류를 고칠 수 있습니다(수정 이력이 남습니다)</small></label>
      <textarea data-tr="${n}" rows="5">${esc(at.transcript)}</textarea>
      <p class="row">
        <button class="small secondary" data-savetr="${n}">전사문 저장</button>
        <button class="small" data-savetr-eval="${n}">저장 후 AI 재평가</button>
        ${ev ? `<button class="small secondary" data-reeval="${n}">AI 재평가</button><button class="small secondary" data-copyfb="${n}">학생에게 보낼 피드백 복사</button>` : ''}
        <button class="small danger" data-reset="${n}">이 단계부터 다시 녹음하게 하기</button>
      </p>
      ${at.transcriptHistory?.length > 1 ? `<details><summary>전사 이력 ${at.transcriptHistory.length}건</summary>${at.transcriptHistory.map((h) => `<p class="kv">${fmtTime(h.at)} · ${SOURCE[h.source] || h.source}</p><p>${nl(h.text)}</p>`).join('')}</details>` : ''}
      ${ev ? evalCard(ev.result, { title: { 1: '2단계 AI 평가 · 1차 피드백', 2: '4·5단계 AI 평가 · 2차 피드백', 3: '7단계 AI 실전 평가' }[n], teacher: true }) + `<p class="kv">평가 모델 ${esc(ev.model)} · ${fmtTime(ev.at)}</p>` : ''}
    </div>`;
  };

  $('#detail').innerHTML = `
    <div class="row"><h2 style="margin:0">${esc(s.alias)}</h2>${STEP_BADGE[s.step]}<span class="spacer" style="flex:1"></span>
      <button class="small secondary" id="reportBtn">기록 보고서(인쇄·PDF)</button>
      <button class="small danger" id="delStudentBtn">학생 삭제</button></div>
    <p class="kv">입장 ${fmtTime(s.created)}</p>
    <h3 style="color:var(--practice)">수행 연습 (1~5단계)</h3>
    ${block(1, '1단계 · 1차 구술', false)}
    ${block(2, '3단계 · 수정 구술', false)}
    <h3 style="color:var(--exam)">실전 수행평가 (6~7단계)</h3>
    ${block(3, '6단계 · 실전 최종 구술', true)}
    ${finalForm(s, c)}
    ${objectionsHtml(s)}
    ${s.archive.length ? `<details><summary>보관된 이전 녹음 ${s.archive.length}건(재응시 전 기록)</summary>${s.archive.map((a, i) => `<p class="kv">${fmtTime(a.at)} 보관 · ${a.n === 'final' ? `이전 교사 최종 평가 ${a.final.total}/${a.final.max}점` : `${a.n}회차`}${a.attempt ? ` · ${fmtSec(a.attempt.durationSec)}` : ''}${a.eval ? ` · AI ${a.eval.result.aiTotal}/${a.eval.result.aiMax}` : ''}</p>${a.attempt ? `<audio controls preload="none" src="/api/audio/${s.id}/archive${i}?t=${t}"></audio><p>${nl(a.attempt.transcript)}</p>` : ''}`).join('')}</details>` : ''}
    <details><summary>활동 기록(${s.log.length})</summary><table>${s.log.map((l) => `<tr><td class="kv">${fmtTime(l.at)}</td><td>${esc(l.event)}</td><td class="kv">${esc(l.detail)}</td></tr>`).join('')}</table></details>`;
  bindDetail(s);
}

function finalForm(s, c) {
  const ev3 = s.evals.e3?.result;
  if (!s.attempts.a3) return '';
  const f = s.final;
  const aiScore = (name) => ev3?.criteria.find((x) => x.name === name)?.score;
  const rows = c.rubric
    .map((r) => {
      const ai = aiScore(r.name);
      const val = f?.scores[r.name] ?? (r.teacherOnly ? '' : ai ?? '');
      return `<span>${esc(r.name)} <span class="hint">(${r.points}점)</span>${r.teacherOnly ? ' <span class="pill gray">교사 채점</span>' : ''}</span>
        <span class="hint">AI ${ai ?? '-'}</span>
        <input type="number" min="0" max="${r.points}" step="1" data-score="${esc(r.name)}" value="${val}">`;
    })
    .join('');
  return `<div class="attempt exam">
    <h3>교사 최종 평가·피드백 ${f?.published ? '<span class="pill">학생 공개됨</span>' : f ? '<span class="pill gray">저장됨(비공개)</span>' : ''}</h3>
    ${!ev3 ? '<p class="warn">7단계 AI 평가가 아직 없습니다. 직접 채점할 수도 있습니다.</p>' : '<p class="hint">AI 점수가 미리 채워져 있습니다. 녹음을 듣고 확인·수정하세요.</p>'}
    <div class="final-grid"><b>기준</b><b class="hint">AI 점수</b><b>확정 점수</b>${rows}</div>
    <p><b>합계 <span id="finalSum"></span></b></p>
    <label>학생에게 줄 최종 피드백 <small>AI 피드백을 바탕으로 다듬어 주세요</small></label>
    <textarea id="finalFb" rows="6">${esc(f?.feedback ?? ev3?.studentFeedback ?? '')}</textarea>
    <label>세특 작성 참고 문장 <small>학생에게는 보이지 않습니다 · 교사 관찰을 바탕으로 반드시 검토·수정</small></label>
    <textarea id="finalRec" rows="3">${esc(f?.record ?? ev3?.recordDraft ?? '')}</textarea>
    <p class="row"><button class="secondary" id="saveFinalBtn">저장(학생 비공개)</button><button id="publishFinalBtn">저장하고 학생에게 공개</button></p>
  </div>`;
}

function objectionsHtml(s) {
  if (!s.objections.length) return '';
  return `<div class="attempt exam"><h3>이의제기</h3>${s.objections
    .map(
      (o, i) => `<div class="note"><b>${fmtTime(o.at)} 학생 의견</b><br>${nl(o.text)}</div>
      <label>답변 ${o.repliedAt ? `<small>${fmtTime(o.repliedAt)} 답변함</small>` : ''}</label>
      <textarea data-reply="${i}" rows="3">${esc(o.reply)}</textarea>
      <p><button class="small" data-sendreply="${i}">답변 저장(학생에게 표시)</button> <span class="hint">점수를 바꿀 경우 위 최종 점수를 수정해 다시 공개하세요.</span></p>`,
    )
    .join('')}</div>`;
}

function bindDetail(s) {
  const d = $('#detail');
  d.oninput = () => {
    detailDirty = true;
    sumFinal();
  };
  sumFinal();
  const act = async (fn, okMsg) => {
    try {
      await fn();
      if (okMsg) toast(okMsg, 'ok');
      detailDirty = false;
      await refreshClass();
      renderDetail(true);
    } catch (e) {
      toast(e.message, 'error');
    }
  };
  $$('[data-savetr]', d).forEach((b) => (b.onclick = () => act(() => api(`/api/students/${s.id}/transcript`, { body: { n: b.dataset.savetr, text: $(`[data-tr="${b.dataset.savetr}"]`, d).value } }), '전사문을 저장했습니다.')));
  $$('[data-savetr-eval]', d).forEach((b) => (b.onclick = () => act(() => api(`/api/students/${s.id}/transcript`, { body: { n: b.dataset.savetrEval, text: $(`[data-tr="${b.dataset.savetrEval}"]`, d).value, reevaluate: true } }), '저장했고 AI 재평가를 요청했습니다.')));
  $$('[data-reeval]', d).forEach((b) => (b.onclick = () => confirm('AI 평가를 다시 받을까요? (이전 결과는 이력으로 보관)') && act(() => api(`/api/students/${s.id}/reevaluate`, { body: { n: b.dataset.reeval } }), 'AI 재평가를 요청했습니다.')));
  $$('[data-reset]', d).forEach(
    (b) =>
      (b.onclick = () =>
        confirm('이 단계부터 학생이 다시 녹음하게 합니다. 지금까지의 녹음·평가는 삭제되지 않고 "보관된 이전 녹음"으로 옮겨집니다. 계속할까요?') &&
        act(() => api(`/api/students/${s.id}/reset`, { body: { n: b.dataset.reset } }), '재응시를 허용했습니다.')),
  );
  const finalBody = (publish) => ({
    scores: Object.fromEntries($$('[data-score]', d).map((i) => [i.dataset.score, i.value])),
    feedback: $('#finalFb').value,
    record: $('#finalRec').value,
    publish,
  });
  const sf = $('#saveFinalBtn');
  if (sf) sf.onclick = () => act(() => api(`/api/students/${s.id}/final`, { body: finalBody(false) }), '저장했습니다(학생 비공개).');
  const pf = $('#publishFinalBtn');
  if (pf) pf.onclick = () => confirm('최종 점수와 피드백을 학생에게 공개합니다.') && act(() => api(`/api/students/${s.id}/final`, { body: finalBody(true) }), '학생에게 공개했습니다.');
  $$('[data-sendreply]', d).forEach((b) => (b.onclick = () => act(() => api(`/api/students/${s.id}/objection/${b.dataset.sendreply}`, { body: { reply: $(`[data-reply="${b.dataset.sendreply}"]`, d).value } }), '답변을 저장했습니다.')));
  $$('[data-copyfb]', d).forEach(
    (b) =>
      (b.onclick = async () => {
        const n = b.dataset.copyfb;
        const r = s.evals['e' + n].result;
        const label = { 1: '1차 피드백(2단계)', 2: '2차 피드백(5단계)', 3: '실전 AI 평가(7단계)' }[n];
        const text = `[${classData.class.title}] ${s.alias} · ${label}\n\n${r.studentFeedback}\n\n생각해 볼 질문\n${r.questions.map((q) => '- ' + q).join('\n')}`;
        try {
          await navigator.clipboard.writeText(text);
          toast('복사했습니다. 클래스룸·메신저에 붙여 넣으세요.', 'ok');
        } catch {
          prompt('아래 내용을 복사하세요.', text);
        }
      }),
  );
  $('#reportBtn').onclick = () => window.open('/report.html?id=' + s.id, '_blank');
  $('#delStudentBtn').onclick = () =>
    confirm(`${s.alias} 학생의 모든 녹음과 기록을 삭제합니다. 되돌릴 수 없습니다.`) &&
    act(async () => {
      await api('/api/students/' + s.id, { method: 'DELETE' });
      selectedId = '';
    }, '삭제했습니다.');
}
function sumFinal() {
  const el = $('#finalSum');
  if (!el) return;
  const inputs = $$('[data-score]');
  const sum = inputs.reduce((a, i) => a + (Number(i.value) || 0), 0);
  const max = inputs.reduce((a, i) => a + Number(i.max), 0);
  el.textContent = `${sum} / ${max}`;
}

// ── 학생 접속(QR) ──
async function renderJoin() {
  const net = await api('/api/network');
  const sel = $('#hostSel');
  const saved = storage('qrHost');
  sel.innerHTML = net.addresses.length ? net.addresses.map((a) => `<option value="${a.ip}">${a.ip} (${esc(a.name)})</option>`).join('') : '<option value="localhost">네트워크 없음(localhost)</option>';
  if (saved && net.addresses.some((a) => a.ip === saved)) sel.value = saved;
  const draw = async () => {
    storage('qrHost', sel.value);
    const q = await api(`/api/classes/${currentCode}/qr?host=${encodeURIComponent(sel.value)}`);
    $('#qrImg').src = q.dataUrl;
    $('#qrLink').textContent = q.link;
    $('#qrCode').textContent = currentCode;
  };
  sel.onchange = draw;
  draw();
}

// ── 메일 제출(영상) ──
const tHeader = () => ({ Authorization: 'Bearer ' + storage('teacherToken') });
async function importJson(f) {
  const r = await fetch(`/api/classes/${currentCode}/import`, { method: 'POST', headers: { ...tHeader(), 'Content-Type': 'application/json' }, body: f });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error);
  return j;
}
async function importMedia(f, extra) {
  const r = await fetch(`/api/classes/${currentCode}/import-media?name=${encodeURIComponent(f.name)}${extra}`, { method: 'POST', headers: { ...tHeader(), 'Content-Type': 'application/octet-stream' }, body: f });
  const j = await r.json();
  if (r.status === 409 && /넣을까요/.test(j.error) && confirm(j.error)) return importMedia(f, extra + '&force=1');
  if (r.status === 422) {
    // 파일 이름이 바뀌어 학생·단계를 읽을 수 없을 때: 교사가 직접 입력
    const alias = prompt(`${f.name}\n파일 이름으로 학생을 알 수 없습니다. 식별명을 입력하세요(예: 2-3-07).`);
    const step = alias && prompt('몇 단계 영상인가요? 1, 3, 6 중 하나를 입력하세요.');
    if (alias && step) return importMedia(f, `${extra}&alias=${encodeURIComponent(alias.trim())}&step=${encodeURIComponent(step.trim())}`);
  }
  if (!r.ok) throw new Error(j.error);
  return j;
}

// ── 독립형 HTML ──
$('#standaloneBtn').onclick = () => download(`/api/classes/${currentCode}/standalone.html`, `구술녹음_${currentCode}.html`);
$('#importIn').onchange = async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  const log = $('#importLog');
  log.innerHTML = '';
  for (const f of files) {
    const line = document.createElement('p');
    line.innerHTML = `<span class="spinner"></span> ${esc(f.name)}`;
    log.append(line);
    try {
      const j = f.name.toLowerCase().endsWith('.json') ? await importJson(f) : await importMedia(f, '');
      line.innerHTML = `✅ ${esc(j.alias)} · ${esc(j.label)} 가져옴 → AI 평가 대기열에 넣었습니다.${j.otherClass ? ` <b>(다른 수업 「${esc(j.classTitle)}」(${j.classCode})에 넣었습니다. 수업 목록에서 확인하세요.)</b>` : ''}`;
    } catch (err) {
      line.innerHTML = `<span class="danger-box">❌ ${esc(f.name)}: ${esc(err.message)}</span>`;
    }
  }
  refreshClass();
};

// ── 내보내기 ──
async function renderExport() {
  const s = await api('/api/settings');
  $('#dataDir').textContent = s.dataDir;
  $('#audioCode').textContent = currentCode;
}
async function download(url, name) {
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + storage('teacherToken') } });
  if (!r.ok) return toast((await r.json().catch(() => ({}))).error || '내려받기 실패', 'error');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(await r.blob());
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
$('#csvBtn').onclick = () => download(`/api/classes/${currentCode}/export.csv`, `구술평가_${currentCode}.csv`);
$('#jsonBtn').onclick = () => download(`/api/classes/${currentCode}/export.json`, `구술평가_${currentCode}.json`);
$('#deleteClassBtn').onclick = async () => {
  const typed = prompt(`수업과 모든 학생 녹음을 영구 삭제합니다. 확인을 위해 수업 코드(${currentCode})를 입력하세요.`);
  if (typed?.trim().toUpperCase() !== currentCode) return;
  try {
    await api('/api/classes/' + currentCode, { method: 'DELETE' });
    toast('삭제했습니다.', 'ok');
    openList();
  } catch (e) {
    toast(e.message, 'error');
  }
};

// ── 설정 ──
async function openSettings() {
  show('settings');
  const s = await api('/api/settings');
  $('#s-model').innerHTML = Object.entries(s.models).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');
  $('#s-model').value = s.model;
  $('#s-effort').value = s.effort;
  $('#s-akey').value = '';
  $('#s-akey-now').textContent = s.anthropicKey ? `현재 저장된 키: ${s.anthropicKey} (바꿀 때만 새로 입력)` : '저장된 키가 없습니다.';
  $('#s-okey').value = '';
  $('#s-okey-now').textContent = s.openaiKey ? `현재 저장된 키: ${s.openaiKey}` : '저장된 키가 없습니다.';
  $('#s-omodel').value = s.openaiSttModel;
  $$('[name=stt]').forEach((r) => (r.checked = r.value === s.sttProvider));
  $('#s-mock').checked = s.mock;
  $('#s-dir').textContent = s.dataDir;
  $('#testResult').textContent = '';
  toggleOpenai();
}
function toggleOpenai() {
  $('#openaiBox').classList.toggle('hidden', $('[name=stt]:checked')?.value !== 'openai');
}
$$('[name=stt]').forEach((r) => (r.onchange = toggleOpenai));
async function saveSettings() {
  const j = await api('/api/settings', {
    body: {
      anthropicKey: $('#s-akey').value.trim(),
      openaiKey: $('#s-okey').value.trim(),
      model: $('#s-model').value,
      effort: $('#s-effort').value,
      sttProvider: $('[name=stt]:checked')?.value,
      openaiSttModel: $('#s-omodel').value,
      mock: $('#s-mock').checked,
      newPassword: $('#s-newpw').value || undefined,
    },
  });
  if (j.token) storage('teacherToken', j.token);
  $('#s-newpw').value = '';
}
$('#saveSettingsBtn').onclick = async () => {
  try {
    await saveSettings();
    toast('설정을 저장했습니다.', 'ok');
    renderBadge();
    openSettings();
  } catch (e) {
    toast(e.message, 'error');
  }
};
$('#testBtn').onclick = async () => {
  $('#testResult').innerHTML = '<span class="spinner"></span> 확인 중…';
  try {
    await saveSettings();
    const r = await api('/api/settings/test', { body: {} });
    $('#testResult').textContent = '✅ ' + r.message;
    renderBadge();
  } catch (e) {
    $('#testResult').textContent = '❌ ' + e.message;
  }
};

boot().catch((e) => toast(e.message, 'error'));
