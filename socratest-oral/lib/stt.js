// 음성 → 텍스트(전사) 모듈
// Claude는 텍스트를 평가하고, 음성 인식은 아래 두 방식 중 하나로 합니다.
//  1) browser : 학생 기기의 브라우저 음성 인식(크롬·엣지·삼성 인터넷·사파리). 무료, 녹음과 동시에 전사.
//  2) openai  : 저장된 녹음 파일을 OpenAI 음성 인식 API로 전사. 유료(분당 약 몇 원~십여 원), 정확도 높음.
// 어느 방식이든 원본 녹음은 그대로 보관되며, 교사가 녹음을 듣고 전사문을 고칠 수 있습니다.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './store.js';

export async function transcribeWithOpenAI(file, mime, hint = '') {
  if (!config.openaiKey) throw new Error('OpenAI 음성 인식 키가 설정되지 않았습니다.');
  const form = new FormData();
  const ext = path.extname(file) || '.webm';
  form.append('file', new Blob([fs.readFileSync(file)], { type: mime || 'audio/webm' }), 'answer' + ext);
  form.append('model', config.openaiSttModel || 'gpt-4o-mini-transcribe');
  form.append('language', 'ko');
  form.append('response_format', 'json');
  // 작품명·핵심어를 힌트로 주면 고유명사 인식이 좋아집니다.
  if (hint) form.append('prompt', hint.slice(0, 400));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120e3);
  try {
    const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.openaiKey}` },
      body: form,
      signal: ctrl.signal,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error('음성 인식 오류: ' + (j.error?.message || r.status));
    return String(j.text || '').trim();
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('음성 인식 시간이 초과되었습니다.');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
