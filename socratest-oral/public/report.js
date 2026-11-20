// 학생별 구술 수행평가 기록 보고서(인쇄 → PDF 저장). 이의제기 대응·증빙 보관용
const api = makeApi('teacherToken');
const SRC = { browser: '브라우저 음성 인식', openai: 'OpenAI 음성 인식', teacher: '교사 수정', mock: '모의' };
(async () => {
  const id = new URLSearchParams(location.search).get('id');
  try {
    const { class: c, student: s } = await api('/api/students/' + encodeURIComponent(id));
    const part = (n, label) => {
      const at = s.attempts['a' + n];
      const ev = s.evals['e' + n];
      if (!at) return `<h3>${label}</h3><p class="muted">제출 없음</p>`;
      return `<h3>${label}</h3>
        <p class="kv">제출 ${new Date(at.submittedAt).toLocaleString('ko-KR')} · 녹음 ${fmtSec(at.durationSec)} · ${at.take}번째 녹음 · 화면 이탈 ${at.hiddenCount}회 · 전사 ${SRC[at.transcriptSource] || at.transcriptSource}<br>
        녹음 파일 ${esc(at.file)}<br>SHA-256 <code>${at.sha256}</code></p>
        <p><b>전사문</b></p><div class="passage" style="max-height:none">${esc(at.transcript)}</div>
        ${ev ? evalCard(ev.result, { title: 'AI 잠정 평가', teacher: true }) + `<p class="kv">평가 모델 ${esc(ev.model)} · ${new Date(ev.at).toLocaleString('ko-KR')}</p>` : ''}`;
    };
    const f = s.final;
    document.title = `구술평가 기록_${s.alias}_${c.title}`;
    $('#report').innerHTML = `
      <p class="no-print"><button>인쇄 / PDF로 저장</button></p>
      <section class="card">
        <h2>구술 수행평가 기록 보고서</h2>
        <table>
          <tr><th>수업</th><td>${esc(c.title)} (${esc(c.areaLabel)}) · 코드 ${c.code}</td></tr>
          <tr><th>학생 식별명</th><td>${esc(s.alias)}</td></tr>
          <tr><th>구술 과제</th><td>${nl(c.task)}</td></tr>
          ${c.standard ? `<tr><th>성취기준</th><td>${nl(c.standard)}</td></tr>` : ''}
          <tr><th>평가 기준</th><td>${c.rubric.map((r) => `${esc(r.name)}(${r.points}점${r.teacherOnly ? ', 교사 채점' : ''}): ${esc(r.desc)}`).join('<br>')}</td></tr>
          <tr><th>출력 일시</th><td>${new Date().toLocaleString('ko-KR')}</td></tr>
        </table>
      </section>
      <section class="card">
        <h2>최종 결과(교사 확정)</h2>
        ${f ? `<table>${c.rubric.map((r) => `<tr><th>${esc(r.name)}</th><td class="num">${f.scores[r.name]} / ${r.points}</td></tr>`).join('')}<tr><th>합계</th><td class="num"><b>${f.total} / ${f.max}</b></td></tr></table>
          <p><b>최종 피드백</b></p><div class="feedback-box">${nl(f.feedback)}</div>
          <p class="kv">저장 ${new Date(f.savedAt).toLocaleString('ko-KR')}${f.publishedAt ? ` · 학생 공개 ${new Date(f.publishedAt).toLocaleString('ko-KR')}` : ' · 미공개'}</p>` : '<p class="muted">아직 확정하지 않음</p>'}
        ${s.objections.length ? `<h3>이의제기</h3>${s.objections.map((o) => `<div class="note"><b>${new Date(o.at).toLocaleString('ko-KR')} 학생</b><br>${nl(o.text)}${o.reply ? `<hr><b>${new Date(o.repliedAt).toLocaleString('ko-KR')} 교사 답변</b><br>${nl(o.reply)}` : ''}</div>`).join('')}` : ''}
      </section>
      <section class="card"><h2>수행 연습(1~5단계)</h2>${part(1, '1단계 1차 구술 → 2단계 AI 1차 피드백')}${part(2, '3단계 수정 구술 → 4·5단계 AI 평가·2차 피드백')}</section>
      <section class="card"><h2>실전 수행평가(6~7단계)</h2>${part(3, '6단계 최종 구술 → 7단계 AI 평가')}</section>
      <section class="card"><h2>활동 기록</h2><table>${s.log.map((l) => `<tr><td class="kv">${new Date(l.at).toLocaleString('ko-KR')}</td><td>${esc(l.event)}</td><td class="kv">${esc(l.detail)}</td></tr>`).join('')}</table></section>`;
    $('#report button').onclick = () => print();
  } catch (e) {
    $('#report').innerHTML = `<p class="danger-box">${esc(e.message)} (교사 화면에서 로그인한 뒤 다시 여세요)</p>`;
  }
})();
