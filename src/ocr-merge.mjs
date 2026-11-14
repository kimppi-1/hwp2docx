// 한글 책 속 원어(헬라어·히브리어)·영어 살리기
// 한국어로 한 번 읽고(A), 헬라어+영어 / 히브리어+영어로 한 번 더 읽어(B) 단어 자리끼리 맞춰 본다.
// 한글이 읽힌 자리는 언제나 A, 한글이 없는 자리에서 B가 원어(또는 더 확실한 영어)를 읽었으면 B로 바꾼다.
const GREEK = /[Ͱ-Ͽἀ-῿]/g;
const HANGUL = /[가-힣]/;
const LETTER = /[\p{L}]/gu;
const greekLower = t => (t.match(/[ά-ώἀ-῿α-ω]/g) || []).length;

export function hasGreekish(words) {
  // A 결과에 '한글 없는 낮은 신뢰도 단어'가 많으면 헬라어가 섞인 쪽일 수 있다
  return words.filter(w => !HANGUL.test(w.text) && /[0-9A-Za-z\u3131-\u318E\u0370-\u03FF\u1F00-\u1FFF\u0590-\u05FF]/.test(w.text) && (w.conf ?? 100) < 70).length >= 3;
}

const ov = (a, b) => {
  const ix = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), iy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  if (ix <= 0 || iy <= 0) return 0;
  const i = ix * iy;
  return i / Math.min((a.x1 - a.x0) * (a.y1 - a.y0) || 1, (b.x1 - b.x0) * (b.y1 - b.y0) || 1);
};

const HEB_LETTER = /[\u05D0-\u05EA\uFB1D-\uFB4F]/g;
const isHebrewWord = t => { const h = (t.match(HEB_LETTER) || []).length, l = (t.match(LETTER) || []).length; return h > 0 && h >= l * 0.8; };
const SCRIPTS = { greek: (t) => isGreekWord(t), hebrew: (t) => isHebrewWord(t) };
const isGreekWord = t => { const g = (t.match(GREEK) || []).length, l = (t.match(LETTER) || []).length; return g > 0 && g >= l * 0.6 && greekLower(t) >= Math.max(1, g * 0.5); };

// B 단어가 믿을 만한지: 헬라어 단어는 그 줄에 헬라어가 꽤 있거나 길고 확실할 때, 영문은 확실할 때
function bGood(b, isW, latin) {
  const letters = (b.text.match(LETTER) || []).length;
  if (!letters) return false;
  if (isW(b.text)) return (b.conf ?? 0) >= 75 && (b._lineGreek >= 0.3 && b._lineStrong || letters >= 4 && b.conf >= 88);
  if (!latin) return false;
  return /^[("‘“]?[A-Za-z][A-Za-z0-9'’-]*[.,;:!?)”’]?$/.test(b.text) && (letters >= 3 || (b.conf ?? 0) >= 90) && (b.conf ?? 0) >= 70;
}

const inter = (a, b) => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
// 같은 줄 높이에서 A 단어 가로 폭의 60% 넘게 B 단어 안에 들면 같은 자리
const xin = (a, b) => { const ix = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), iy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0); return ix > 0 && iy > 0.3 * Math.min(a.y1 - a.y0, b.y1 - b.y0) && (ix >= 0.6 * (a.x1 - a.x0) || ix >= 0.6 * (b.x1 - b.x0)); };
const area = a => Math.max(1, (a.x1 - a.x0) * (a.y1 - a.y0));

// A: [[word]] (줄 단위, 한국어), B: [[word]] (줄 단위, 원어+영어) → 줄 단위 결과
export function mergeGreek(A, Blines) { return mergeScript(A, Blines, 'greek'); }
export function mergeScript(A, Blines, script = 'greek', { latin = true } = {}) {
  const isW = SCRIPTS[script];
  const B = [];
  for (const l of Blines) {
    const words = l.filter(w => (w.text.match(LETTER) || []).length);
    const r = words.length ? words.filter(w => isW(w.text)).length / words.length : 0;
    const strong = l.some(w => isW(w.text) && (w.text.match(LETTER) || []).length >= (script === 'hebrew' ? 3 : 4) && (w.conf ?? 0) >= 85);
    for (const w of l) if (bGood({ ...w, _lineGreek: r, _lineStrong: strong }, isW, latin)) B.push({ ...w, greek: isW(w.text) });
  }
  const lines = A.map(l => l.map(w => ({ ...w })));
  const all = lines.flatMap((l, li) => l.map(w => (w._li = li, w)));
  for (const b of B) {
    const hit = all.filter(a => !a._gone && xin(a, b));
    if (!hit.length) continue;
    const bc = b.conf ?? 0;
    const syl = t => (t.match(/[\uAC00-\uD7A3]/g) || []).length;
    // 두 글자 넘는 한글 낱말은 어지간히 흐려도 한글로 둔다
    const korean = hit.some(a => syl(a.text) && ((a.conf ?? 0) >= (b.greek ? 80 : 60) || syl(a.text) >= 2 && (a.conf ?? 0) >= (b.greek ? 45 : 30)));
    const number = hit.length === 1 && /^[\d.,:;()\-–]+$/.test(hit[0].text) && (hit[0].conf ?? 0) >= (b.greek ? 85 : 60);
    if (korean || number) continue;
    const aMax = Math.max(...hit.map(a => a.conf ?? 0));
    if (!b.greek && bc < 70 && bc < aMax - 10) continue;
    for (const a of hit) a._gone = true;
    const { greek, ...w } = b;
    lines[hit[0]._li].push({ ...w, _li: hit[0]._li });
  }
  return lines.map(l => l.filter(w => !w._gone).map(({ _li, _gone, ...w }) => w).sort((p, q) => p.x0 - q.x0)).filter(l => l.length);
}
