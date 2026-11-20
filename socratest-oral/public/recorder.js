// 학생 구술 녹음기
// - MediaRecorder로 원본 음성을 녹음(이의제기 대응용으로 교사 PC에 보관)
// - 설정이 '브라우저 음성 인식'이면 Web Speech API로 녹음과 동시에 글로 변환
// - 실전 평가에서는 녹음 중 다른 화면으로 나간 횟수를 기록(교사 참고용)
const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;

function pickMime() {
  const list = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  return window.MediaRecorder ? list.find((m) => MediaRecorder.isTypeSupported?.(m)) || '' : '';
}

class OralRecorder {
  constructor(el, opts) {
    this.el = el;
    this.o = opts; // { maxSeconds, browserStt, assessment, takesLeft, onBeforeStart, onSubmit }
    this.busy = false;
    this.renderIdle();
  }

  renderIdle(message = '') {
    const o = this.o;
    const sttNote = o.browserStt
      ? SpeechRec
        ? '말하는 동안 아래에 글자로 표시됩니다. 인식이 조금 틀려도 괜찮아요. 선생님이 녹음을 듣고 확인합니다.'
        : '⚠ 이 브라우저는 음성 인식을 지원하지 않아요. 녹음은 그대로 저장되고 선생님이 글로 옮겨 평가합니다. (크롬·엣지·삼성 인터넷 권장)'
      : '녹음을 제출하면 선생님 PC에서 자동으로 글로 바뀝니다.';
    this.el.innerHTML = `<div class="recorder">
      ${message ? `<p class="danger-box">${esc(message)}</p>` : ''}
      <p>${
        o.assessment
          ? `<span class="pill exam">실전</span> 처음부터 끝까지 한 번에 말해 주세요. 녹음 기회: <b>${o.takesLeft}회</b> 남음`
          : '<span class="pill practice">연습</span> 제출 전까지 몇 번이든 다시 녹음할 수 있어요.'
      }</p>
      <p class="muted">최대 ${fmtSec(o.maxSeconds)} · 조용한 곳에서 마이크 가까이 또박또박 말해 주세요.<br>${sttNote}</p>
      <button class="big rec" data-act="start" ${o.takesLeft <= 0 ? 'disabled' : ''}>● 녹음 시작</button>
    </div>`;
    $('[data-act=start]', this.el).onclick = () => this.start();
  }

  async start() {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      return this.renderIdle('이 주소에서는 마이크를 쓸 수 없어요. 선생님이 알려 준 https:// 주소(QR코드)로 접속하세요.');
    }
    if (!window.MediaRecorder) return this.renderIdle('이 브라우저는 녹음을 지원하지 않아요. 크롬·엣지·사파리 최신 버전을 사용하세요.');
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch {
      return this.renderIdle('마이크 사용이 허용되지 않았어요. 주소창의 자물쇠(또는 ⓘ)를 눌러 마이크를 "허용"으로 바꾼 뒤 다시 시도하세요.');
    }
    try {
      await this.o.onBeforeStart?.();
    } catch (e) {
      this.stopTracks();
      return this.renderIdle(e.message);
    }
    this.busy = true;
    this.mime = pickMime();
    this.chunks = [];
    this.rec = new MediaRecorder(this.stream, this.mime ? { mimeType: this.mime } : undefined);
    this.rec.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.rec.start(1000);
    this.startedAt = Date.now();
    this.hidden = 0;
    this.onVis = () => document.hidden && this.hidden++;
    document.addEventListener('visibilitychange', this.onVis);
    this.finalText = '';
    this.interim = '';

    this.el.innerHTML = `<div class="recorder recording">
      <p><span class="rec-dot"></span> 녹음 중 <span class="timer" data-t>0:00</span> <span class="muted" data-left></span></p>
      <div class="meter"><i data-m></i></div>
      ${this.o.browserStt && SpeechRec ? '<div class="live" data-live><span class="muted">말하기를 시작하세요…</span></div>' : ''}
      <button class="big" data-act="stop">■ 녹음 끝내기</button>
    </div>`;
    $('[data-act=stop]', this.el).onclick = () => this.stop();
    this.startMeter();
    if (this.o.browserStt && SpeechRec) this.startStt();
    this.tick = setInterval(() => {
      const sec = Math.floor((Date.now() - this.startedAt) / 1000);
      const left = this.o.maxSeconds - sec;
      $('[data-t]', this.el).textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
      $('[data-left]', this.el).textContent = left <= 30 ? `(${left}초 남음)` : '';
      if (left <= 0) this.stop();
    }, 250);
  }

  startMeter() {
    try {
      this.ac = new (window.AudioContext || window.webkitAudioContext)();
      const an = this.ac.createAnalyser();
      an.fftSize = 512;
      this.ac.createMediaStreamSource(this.stream).connect(an);
      const data = new Uint8Array(an.fftSize);
      const draw = () => {
        if (!this.busy || !this.rec || this.rec.state !== 'recording') return;
        an.getByteTimeDomainData(data);
        let peak = 0;
        for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
        const bar = $('[data-m]', this.el);
        if (bar) bar.style.width = Math.min(100, peak * 1.6) + '%';
        requestAnimationFrame(draw);
      };
      draw();
    } catch {}
  }

  startStt() {
    const sr = new SpeechRec();
    sr.lang = 'ko-KR';
    sr.continuous = true;
    sr.interimResults = true;
    sr.onresult = (e) => {
      this.interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) this.finalText += r[0].transcript.trim() + ' ';
        else this.interim += r[0].transcript;
      }
      const live = $('[data-live]', this.el);
      if (live) live.innerHTML = esc(this.finalText) + `<span class="muted">${esc(this.interim)}</span>`;
    };
    // 크롬은 잠시 말을 멈추면 인식을 끝내므로 녹음 중에는 자동으로 다시 시작합니다.
    sr.onend = () => {
      if (this.rec?.state === 'recording') {
        try {
          sr.start();
        } catch {}
      } else this.sttDone?.();
    };
    sr.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') this.sttFailed = true;
    };
    this.sr = sr;
    try {
      sr.start();
    } catch {}
  }

  stopTracks() {
    this.stream?.getTracks().forEach((t) => t.stop());
  }

  async stop() {
    if (!this.rec || this.rec.state !== 'recording') return;
    clearInterval(this.tick);
    document.removeEventListener('visibilitychange', this.onVis);
    this.durationSec = Math.round((Date.now() - this.startedAt) / 1000);
    const stopped = new Promise((r) => (this.rec.onstop = r));
    this.rec.stop();
    await stopped;
    if (this.sr) {
      // 마지막 문장이 확정될 때까지 잠깐 기다립니다.
      await new Promise((r) => {
        this.sttDone = r;
        try {
          this.sr.stop();
        } catch {
          r();
        }
        setTimeout(r, 1500);
      });
      if (this.interim) this.finalText += this.interim;
    }
    this.stopTracks();
    this.ac?.close().catch(() => {});
    const type = (this.rec.mimeType || this.mime || 'audio/webm').split(';')[0];
    this.blob = new Blob(this.chunks, { type });
    this.transcript = this.finalText.trim();
    if (this.o.assessment) this.o.takesLeft--;
    this.renderReview();
  }

  renderReview() {
    const o = this.o;
    const url = URL.createObjectURL(this.blob);
    const canRetake = !o.assessment || o.takesLeft > 0;
    this.el.innerHTML = `<div class="recorder">
      <p><b>녹음 확인</b> · ${fmtSec(this.durationSec)}</p>
      <audio controls src="${url}"></audio>
      ${
        o.browserStt
          ? `<div class="live">${this.transcript ? esc(this.transcript) : '<span class="muted">(음성 인식 결과가 없어요. 녹음은 저장되며 선생님이 확인합니다.)</span>'}</div>`
          : ''
      }
      ${o.assessment ? '<p class="warn">제출하면 수정할 수 없습니다. 녹음을 들어 보고 제출하세요.</p>' : ''}
      <div class="row" style="justify-content:center">
        <button class="big" data-act="submit">제출하기</button>
        ${canRetake ? `<button class="secondary" data-act="again">다시 녹음${o.assessment ? ` (기회 ${o.takesLeft}회 남음)` : ''}</button>` : ''}
      </div>
    </div>`;
    $('[data-act=submit]', this.el).onclick = (e) => this.submit(e.target);
    const again = $('[data-act=again]', this.el);
    if (again) again.onclick = () => this.start();
  }

  async submit(btn) {
    if (this.durationSec < 3) return toast('녹음이 너무 짧아요. 다시 녹음해 주세요.', 'error');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> 보내는 중…';
    try {
      await this.o.onSubmit({
        blob: this.blob,
        durationSec: this.durationSec,
        transcript: this.transcript,
        hiddenCount: this.hidden,
        startedAt: this.startedAt,
      });
      this.busy = false;
    } catch (e) {
      toast(e.message, 'error');
      btn.disabled = false;
      btn.textContent = '다시 제출하기';
    }
  }
}
