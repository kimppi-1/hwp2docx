// 글자 인식 결과의 한글 오타·띄어쓰기 바로잡기
//  - 언어 모형(Kiwi 형태소 분석기의 문장 점수)으로 '더 말이 되는' 쪽을 고른다
//  - 오타: 글자 인식이 잘 헷갈리는 자모(ㅁ↔ㅇ, ㄹ↔ㅌ, ㅏ↔ㅐ …)를 한 군데 바꿔 본 후보 가운데 점수가 크게 오르는 것만
//  - 띄어쓰기: 붙여 보기·떼어 보기 후보를 같은 방식으로 견주되, 사진에서 잰 글자 사이 빈칸이 뒷받침할 때만 바꾼다
//    (책은 원본 띄어쓰기가 정답이므로, 사진 증거 없이 '맞춤법상 더 옳은' 쪽으로 바꾸지 않는다)

const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
const JUNG = 'ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ';
const JONG = ' ㄱㄲㄳㄴㄵㄶㄷㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅄㅅㅆㅇㅈㅊㅋㅌㅍㅎ';
// 글자 인식이 서로 헷갈리는 자모 (모양이 비슷한 것)
const CC = { 'ㄱ': 'ㅋㄲ', 'ㅋ': 'ㄱ', 'ㄲ': 'ㄱ', 'ㄷ': 'ㄹㅌㄴ', 'ㄹ': 'ㄷㅌㄴ', 'ㅌ': 'ㄷㄹ', 'ㄴ': 'ㄹㄷ', 'ㅁ': 'ㅇㅂㅍ', 'ㅇ': 'ㅁㅎ', 'ㅎ': 'ㅇ', 'ㅂ': 'ㅁㅃ', 'ㅃ': 'ㅂ', 'ㅍ': 'ㅁ', 'ㅅ': 'ㅆㅈ', 'ㅆ': 'ㅅ', 'ㅈ': 'ㅊㅅ', 'ㅊ': 'ㅈ' };
const VC = { 'ㅏ': 'ㅐㅓㅣ', 'ㅐ': 'ㅏㅔ', 'ㅓ': 'ㅔㅏㅣ', 'ㅔ': 'ㅓㅐ', 'ㅗ': 'ㅜㅡ', 'ㅜ': 'ㅗㅡㅠ', 'ㅡ': 'ㅜㅗ', 'ㅕ': 'ㅑㅖ', 'ㅑ': 'ㅕ', 'ㅚ': 'ㅢㅘ', 'ㅢ': 'ㅚ', 'ㅘ': 'ㅚ', 'ㅣ': 'ㅓㅏ', 'ㅠ': 'ㅜ', 'ㅖ': 'ㅕ' };
const JC = { ' ': 'ㅇㄴㄹㅁ', 'ㅁ': 'ㅇ ', 'ㅇ': 'ㅁ ', 'ㄹ': 'ㅌㄷ ', 'ㅌ': 'ㄹ', 'ㄷ': 'ㄹ', 'ㄴ': 'ㄹ ', 'ㄱ': ' ', 'ㅆ': 'ㅅ', 'ㅅ': 'ㅆ', 'ㅎ': 'ㅇ', 'ㅂ': 'ㅁ' };
const dec = (c) => { const o = c.charCodeAt(0) - 0xAC00; return o >= 0 && o < 11172 ? [Math.floor(o / 588), Math.floor((o % 588) / 28), o % 28] : null; };
const enc = (a, b, c) => String.fromCharCode(0xAC00 + a * 588 + b * 28 + c);
const isH = (c) => c >= '가' && c <= '힣';

function* variants(w) {
  for (let i = 0; i < w.length; i++) {
    const d = dec(w[i]); if (!d) continue;
    const [a, b, c] = d;
    for (const x of CC[CHO[a]] || '') yield w.slice(0, i) + enc(CHO.indexOf(x), b, c) + w.slice(i + 1);
    for (const x of VC[JUNG[b]] || '') yield w.slice(0, i) + enc(a, JUNG.indexOf(x), c) + w.slice(i + 1);
    for (const x of JC[JONG[c]] || '') yield w.slice(0, i) + enc(a, b, JONG.indexOf(x)) + w.slice(i + 1);
  }
}
// 낱말을 앞 부호 · 한글 몸통 · 뒤 부호로
const parts = (t) => { const m = t.match(/^([^가-힣]*)([가-힣](?:.*[가-힣])?)([^가-힣]*)$/); return m && !/[^가-힣]/.test(m[2]) ? { pre: m[1], core: m[2], post: m[3] } : null; };

/**
 * @param score (text) => number  문장 점수(클수록 자연스러움)
 * @param opts.typoGain 오타로 볼 점수 차, opts.spaceGain 띄어쓰기 점수 차
 */
export function makeKoFixer(kiwi, opts = {}) {
  const score = typeof kiwi === 'function' ? kiwi : kiwi.score;
  const analyzeTokens = typeof kiwi === 'function' ? null : kiwi.tokens;
  const typoGain = opts.typoGain ?? 11;
  const cache = new Map();
  const S = (t) => { t = t.trim(); if (!cache.has(t)) { if (cache.size > 50000) cache.clear(); cache.set(t, score(t)); } return cache.get(t); };
  const txt = (ws) => ws.map(w => w.text).join(' ');

  const mcache = new Map();
  const morphs = (t) => { if (!mcache.has(t)) { if (mcache.size > 20000) mcache.clear(); let r = []; try { r = analyzeTokens(t); } catch {} mcache.set(t, r); } return mcache.get(t); };
  // 사전에 없어도 성경·교회 글에 흔한 말 (바꾸지 않는다)
  const KEEP = new Set('율례 규례 법도 권속 열조 성막 번제 소제 화목제 속죄제 휘장 장자 할례 언약궤 성소 지성소 제사장 대제사장 선지자 이방 이방인 열국 족속 장로 사도 서신 복음서 계명 성령 성부 성자 은혜 긍휼 구속 구속사 칭의 성화 영화 환난 권능 심판 재림 강림 부활 승천 회개 세례 침례 성찬 안식일 안식 유월절 오순절 초막절 할렐루야 아멘 여호와 아도나이 엘로힘 임마누엘 메시아 그리스도 바울 베드로 요한 야고보 아브라함 이삭 야곱 요셉 모세 아론 여호수아 다윗 솔로몬 엘리야 엘리사 이사야 예레미야 에스겔 다니엘 암몬 모압 에돔 블레셋 가나안 애굽 바벨론 앗수르 벧엘 브엘세바 헤브론 세겜 갈대아 하란 소돔 고모라 시내 호렙 요단 갈릴리 사마리아 유대 예루살렘 시온 고린도 에베소 빌립보 골로새 데살로니가 갈라디아 로마 성도 형제 자매 성결 정결 거룩 경건 의인 죄인 율법 선민'.split(' '));
  // 어절을 새로 여는 품사 (조사·어미·접미사·지정사·부호는 앞에 붙는다)
  const OPEN = /^(NN[GP]|NR|NP|VV|VA|VCN|MM|MAG|MAJ|IC|XPN|XR|SN|SL|SH|W_)/;
  const ATTACH = /^(J|E|XS|VCP|SF|SP|SS[C]|SE|SO)/;
  function respace(ws, geo, log, around = {}) {
    // 글자 이음: 낱말 사이(빈칸 있음)와 낱말 안(빈칸 없음)
    const chars = [], bnd = [];   // bnd[i]: i번째 글자 앞 자리 { space, word, k }
    ws.forEach((w, wi) => { [...w.text].forEach((c, k) => { bnd.push({ space: wi > 0 && k === 0, wi, k }); chars.push(c); }); });
    // 앞뒤 줄 글자를 조금 붙여 함께 분석 (줄 첫·끝의 잘린 낱말 조각이 엉뚱하게 분석되지 않게)
    const pre = (around.before || '').replace(/\s+/g, '').slice(-8), post = (around.after || '').replace(/\s+/g, '').slice(0, 8);
    const str = pre + chars.join('') + post;
    let toks;
    try { toks = analyzeTokens(str); } catch { return ws; }
    // 글자 자리 → 그 자리에서 시작하는 형태소
    const startTag = new Map(); const inside = new Set();
    for (const t of toks) {
      const pos = t.position - pre.length;
      if (!startTag.has(pos)) startTag.set(pos, t.tag);
      for (let q = pos + 1; q < pos + t.length; q++) inside.add(q);
    }
    const want = (i) => {
      if (inside.has(i)) return false;   // 한 형태소 가운데
      const tag = startTag.get(i); if (!tag) return null;
      if (ATTACH.test(tag)) return false;
      if (tag === 'VX' || tag === 'NNB') return tag === 'NNB' ? true : null;   // 보조 용언은 붙여도 띄어도 맞다 → 사진대로
      if (/[.,!?)」』”’]/.test(chars[i - 1])) return true;   // 문장 부호 뒤
      return OPEN.test(tag) ? true : null;
    };
    const change = [];
    for (let i = 1; i < chars.length; i++) {
      if (!/[가-힣]/.test(chars[i]) || !/[가-힣.,!?]/.test(chars[i - 1])) continue;
      const w = want(i); if (w == null) continue;
      const b = bnd[i];
      if (b.space && !w && !/[.,!?;:)」』”’]/.test(chars[i - 1])) {
        // 형태소 가운데(찾|아내, 고|개를)이거나 조사·어미 앞(바람 이)이면 말로 보아 확실히 붙는 자리 → 틈이 아주 넓지 않으면 붙인다
        const sure = inside.has(i) || /^(J|E)/.test(startTag.get(i) || '');
        const ok = geo ? (sure ? geo.joinOk(ws[b.wi - 1], ws[b.wi], true) : geo.joinOk(ws[b.wi - 1], ws[b.wi])) : true;
        if (ok !== false) change.push({ i, to: false });
      }
      else if (!b.space && w) { const ok = geo ? geo.splitOk(ws[b.wi], b.k) : null; if (ok === true || (ok == null && !geo)) change.push({ i, to: true }); }
    }
    if (!change.length) return ws;
    // 새 낱말들: 바뀐 자리대로 다시 묶고, 상자는 글자 비율로 나눈다
    const sp = bnd.map(b => b.space); for (const c of change) sp[c.i] = c.to;
    const out = []; let cur = null;
    for (let i = 0; i < chars.length; i++) {
      const b = bnd[i], w = ws[b.wi], n = [...w.text].length;
      const cx0 = w.x0 != null ? w.x0 + (w.x1 - w.x0) * b.k / n : null, cx1 = w.x0 != null ? w.x0 + (w.x1 - w.x0) * (b.k + 1) / n : null;
      if (!cur || sp[i]) { cur = { ...w, text: '', cuts: [], x0: cx0, x1: cx1, src: new Set() }; out.push(cur); }
      cur.text += chars[i]; cur.x1 = cx1; cur.src.add(b.wi);
      if (change.some(c => c.i === i || c.i === i + 1)) cur.fixed = 'space';
    }
    for (const o of out) {
      const src = [...o.src].map(k => ws[k]); delete o.src;
      o.y0 = Math.min(...src.map(w => w.y0 ?? 0)); o.y1 = Math.max(...src.map(w => w.y1 ?? 0)); o.conf = Math.min(...src.map(w => w.conf ?? 80));
      if (src.some(w => w.fixed)) o.fixed = o.fixed || src.find(w => w.fixed).fixed;
    }
    log?.push({ kind: 'space', from: ws.map(w => w.text).join(' '), to: out.map(w => w.text).join(' ') });
    return out;
  }
  // 한 줄 낱말들 → 고친 낱말들. 낱말: { text, x0, x1, y0, y1, conf, cuts? } (상자는 없어도 됨)
  // geo.joinOk(a, b) / geo.splitOk(w, k): 사진의 빈칸이 '붙임/띄움'을 허락하는지 (true/false, 모르면 null)
  function fixLine(words, geo = null, log = null, around = {}) {
    let ws = words.map(w => ({ ...w }));
    // 3) 오타 (띄어쓰기를 바로잡은 뒤, 온전한 낱말 단위로)
    for (let i = 0; i < ws.length; i++) {
      const p = parts(ws[i].text); if (!p) continue;
      const ctx = (core) => txt([...ws.slice(Math.max(0, i - 1), i), { text: p.pre + core + p.post }, ...ws.slice(i + 1, i + 2)]);
      const base = S(ctx(p.core));
      let best = null;
      for (const v of new Set(variants(p.core))) {
        const s = S(ctx(v)) - base;
        if (!best || s > best.g) best = { g: s, v };
      }
      // 줄 끝에서 다음 줄로 이어지는 조각(합니|다)·줄 첫머리 조각은 고치지 않는다
      const frag = (i === ws.length - 1 && around.after && !p.post) || (i === 0 && around.before && !/[.,!?」』”’)]$/.test(around.before.trim()));
      const need = (frag ? 10 : 0) + typoGain + (i === 0 || i === ws.length - 1 ? 4 : 0) + (p.core.length <= 2 ? 6 : 0) + ((ws[i].conf ?? 0) >= 90 ? 5 : 0);   // 줄 끝 낱말(앞뒤 줄로 이어지는 조각일 수 있음)·한 글자 낱말은 더 엄하게
      if (!best || best.g <= need) continue;
      if ([...KEEP].some(k => p.core.startsWith(k) && p.core.length - k.length <= 3)) continue;
      // 원래 낱말이 사전에 있는 말로 멀쩡히 나뉘면(성도, 형제들아) 함부로 바꾸지 않는다:
      //  사전에 없는 조각이 있거나, 조각이 잘게 깨졌다가(흐+ㄹ+날리…) 후보에서 줄어들 때만
      if (analyzeTokens) {
        const A = morphs(p.core + p.post), B = morphs(best.v + p.post);
        const oovA = A.some(t => t.oov), oovB = B.some(t => t.oov);
        if (oovB) continue;
        if (!oovA && !(B.length < A.length || (best.g >= need + 3 && A.some(t => t.tag === 'IC')))) continue;
      }
      let v = best.v, g = best.g;
      if (v.length >= 3) {   // 두 군데 틀린 낱말: 한 번 더
        const b2 = S(ctx(v)); let bb = null;
        for (const v2 of new Set(variants(v))) { const s = S(ctx(v2)) - b2; if (!bb || s > bb.g) bb = { g: s, v: v2 }; }
        if (bb && bb.g > need + 2) { v = bb.v; g += bb.g; }
      }
      log?.push({ kind: 'typo', from: ws[i].text, to: p.pre + v + p.post, gain: Math.round(g) });
      ws[i] = { ...ws[i], text: p.pre + v + p.post, fixed: 'typo', was: ws[i].was ?? ws[i].text };
    }
    // 1) 띄어쓰기: 줄을 빈칸 없이 이어 형태소로 나눈 뒤, 낱말(어절)이 시작되는 자리에만 빈칸.
    //    (책의 원래 띄어쓰기가 정답이므로, 사진의 글자 사이 틈이 그 판단을 허락할 때만 바꾼다)
    if (analyzeTokens) ws = respace(ws, geo, log, around);
    return ws;
  }
  return { fixLine, score: S };
}

// Kiwi(형태소 분석기, LGPL) 불러오기 — 라이브러리는 jsDelivr, 언어 모형 파일은 같은 사이트(vendor/kiwi)에서
export async function loadKiwiScorer({ importKiwi, wasmUrl, fetchModel }) {
  const { KiwiBuilder } = await importKiwi();
  const b = await KiwiBuilder.create(wasmUrl);
  const files = {};
  for (const f of ['sj.knlm', 'sj.morph', 'combiningRule.txt', 'extract.mdl']) files[f] = await fetchModel(f);
  const k = await b.build({ modelFiles: files, modelType: 'knlm', loadDefaultDict: false, loadMultiDict: false, loadTypoDict: false });
  return { score: (t) => k.analyze(t).score, tokens: (t) => k.tokenize(t).map(x => ({ position: x.position, length: x.length, tag: x.tag, form: x.str, oov: x.morphId === 2 })) };
}
