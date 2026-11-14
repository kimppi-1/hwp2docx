// 성경 원어 책(원어 대조·주석)의 히브리어를 '성경 본문'으로 바로잡기
// 글자 인식(tesseract)은 모음 부호(니쿠드)가 붙은 히브리어를 잘 못 읽는다. 그래서
//  1) 히브리어로 읽힌 조각(자음만이라도)과 스트롱 번호 줄로 이 쪽이 어느 구절인지 찾고
//  2) 그 구절의 히브리어 성경(웨스트민스터 레닌그라드 사본, OSHB 판)에서 맞는 낱말을 골라
//     모음 부호까지 정확한 글자로 바꿔 넣는다.
// 성경 본문 자료(vendor/wlc/wlc.txt.gz): Open Scriptures Hebrew Bible (CC BY 4.0), WLC는 퍼블릭 도메인.

const FINAL = { 'ך': 'כ', 'ם': 'מ', 'ן': 'נ', 'ף': 'פ', 'ץ': 'צ' };
export const consKey = (t) => {
  let k = '';
  for (const c of t.normalize('NFD')) if (c >= 'א' && c <= 'ת') k += FINAL[c] || c;
  return k;
};
const HANGUL = /[가-힣]/;
const syl = (t) => (t.match(/[가-힣]/g) || []).length;

// "Gen 12:1\tוַיֹּאמֶר|559 יְהוָה|3068 ..." → 구절 목록 + 자음 색인
export function parseWLC(text) {
  const verses = [];
  const flat = [];   // 성경 전체 낱말(차례대로) — 구절이 이어지는 자리도 이어서 볼 수 있게
  const byKey = new Map();
  for (const line of text.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const ref = line.slice(0, tab);
    const words = line.slice(tab + 1).split(' ').filter(Boolean).map((t) => {
      const bar = t.indexOf('|');
      const w = bar < 0 ? t : t.slice(0, bar);
      return { w, s: bar < 0 ? 0 : +t.slice(bar + 1), k: consKey(w) };
    });
    const vi = verses.length;
    const off = flat.length;
    words.forEach((w, j) => { w.g = off + j; w.vi = vi; flat.push(w); });
    verses.push({ ref, words, off });
    for (const x of words) {
      if (x.k.length < 2) continue;
      let a = byKey.get(x.k);
      if (!a) byKey.set(x.k, (a = []));
      if (a[a.length - 1] !== vi) a.push(vi);
    }
  }
  return { verses, byKey, flat };
}

let wlcP = null;
// 브라우저: 사이트에 함께 올린 압축 파일을 처음 한 번 받는다(약 1.5MB)
export function loadWLC(url) {
  if (!wlcP) wlcP = (async () => {
    const res = await fetch(url);
    if (!res.ok) throw new Error('WLC ' + res.status);
    let text;
    if (typeof DecompressionStream !== 'undefined' && /\.gz$/.test(url)) text = await new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).text();
    else text = await res.text();
    return parseWLC(text);
  })().catch((e) => { wlcP = null; throw e; });
  return wlcP;
}

function lev(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
const sim = (a, b) => 1 - lev(a, b) / Math.max(a.length, b.length, 1);

// 가장 긴 공통 부분열로 두 번호 줄을 맞춘다 → [i, j] 짝들
function lcsPairs(a, b) {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, () => new Int16Array(n + 1));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) d[i][j] = a[i] === b[j] ? d[i + 1][j + 1] + 1 : Math.max(d[i + 1][j], d[i][j + 1]);
  const out = [];
  for (let i = 0, j = 0; i < m && j < n;) {
    if (a[i] === b[j]) { out.push([i, j]); i++; j++; } else if (d[i + 1][j] >= d[i][j + 1]) i++; else j++;
  }
  return out;
}

const inX = (a, x0, x1) => { const c = (a.x0 + a.x1) / 2; return c >= x0 && c <= x1; };
const vOverlap = (a, b) => Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > 0.3 * Math.min(a.y1 - a.y0, b.y1 - b.y0);
const xOverlap = (a, b) => { const ix = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0); return ix > 0 && (ix >= 0.5 * (a.x1 - a.x0) || ix >= 0.5 * (b.x1 - b.x0)); };
const lineBox = (l) => ({ x0: Math.min(...l.map((w) => w.x0)), y0: Math.min(...l.map((w) => w.y0)), x1: Math.max(...l.map((w) => w.x1)), y1: Math.max(...l.map((w) => w.y1)) });

// A: 한국어(+헬라어·영어로 고친) 줄들 [[word]], H: 히브리어로 읽은 줄들 [[word]], wlc: parseWLC 결과
// → 히브리어 자리가 성경 본문 글자로 바뀐 A
export function fixHebrew(A, H, wlc, opts = {}) {
  const lines = A.map((l) => l.map((w) => ({ ...w })));
  // 1) 히브리어 조각: 히브리어 글자 2개 넘게 든 낱말 (같은 낱말 안 잡티는 버리고 히브리어 덩어리만)
  const toks = [];
  for (const l of H) for (const w of l) {
    const parts = w.text.match(/[א-ת֑-ׇיִ-ﭏ־-]+/g) || [];
    const keys = parts.map((p) => consKey(p)).filter((k) => k.length >= 2);
    if (keys.length) toks.push({ ...w, keys });
  }
  // 2) 스트롱 번호 줄 (숫자만 있는 줄)
  const numRows = [];
  lines.forEach((l, li) => {
    // 왼쪽부터 늘어선 낱말 중 숫자(1~8674)가 이어진 가장 긴 덩어리 (오른쪽 번역 칸 글자는 끊긴다)
    const ws = l.slice().sort((a, b) => a.x0 - b.x0);
    const isNum = (w) => /^\d{1,4}$/.test(w.text) && +w.text > 0 && +w.text <= 8674 && (w.conf ?? 100) >= 50;
    let bestRun = [], cur = [];
    for (const w of ws) { if (isNum(w)) cur.push(w); else { if (cur.length > bestRun.length) bestRun = cur; cur = []; } }
    if (cur.length > bestRun.length) bestRun = cur;
    if (bestRun.length >= 2 || (bestRun.length === 1 && ws.length === 1)) numRows.push({ li, nums: bestRun.slice().sort((a, b) => b.x0 - a.x0) });
  });
  if (toks.length < 2 && !numRows.some((r) => r.nums.length >= 3)) return lines;

  // 3) 어느 구절인가: 히브리어 조각 표 + 스트롱 번호 줄 표
  const votes = new Map();
  const add = (vi, v) => votes.set(vi, (votes.get(vi) || 0) + v);
  for (const t of toks) for (const k of t.keys) {
    if (k.length < 3) continue;
    const vs = wlc.byKey.get(k);
    if (!vs || vs.length > 3000) continue;
    const wgt = 1 / Math.log2(vs.length + 2);
    for (const vi of vs) add(vi, wgt);
  }
  // 이웃 구절끼리 표를 모아 가장 진한 자리(쪽 하나는 대개 몇 구절)
  let best = -1, bestScore = 0;
  for (const [vi] of votes) {
    let s = 0;
    for (let d = -2; d <= 4; d++) s += votes.get(vi + d) || 0;
    if (s > bestScore) { bestScore = s; best = vi; }
  }
  const cand = new Set();
  if (best >= 0 && bestScore >= 1.2) for (let d = -4; d <= 8; d++) if (wlc.verses[best + d]) cand.add(best + d);

  // 번호 줄을 구절에 맞춘다: 앞 줄의 구절을 이어서 먼저, 아니면 후보 구절, 그래도 없으면 성경 전체
  const fills = [];
  let prev = null;
  const tryVerse = (vi, seq, from = 0) => {
    const v = wlc.verses[vi];
    if (!v) return null;
    const ss = v.words.slice(from).map((w) => w.s);
    const pairs = lcsPairs(seq, ss).map(([i, j]) => [i, j + from]);
    return { vi, pairs, score: pairs.length / seq.length };
  };
  for (const row of numRows) {
    const seq = row.nums.map((w) => +w.text);
    let m = null;
    if (prev) {
      for (const [vi, from] of [[prev.vi, prev.next], [prev.vi + 1, 0]]) {
        const r = tryVerse(vi, seq, from);
        if (r && r.pairs.length && r.score >= (seq.length === 1 ? 1 : 0.6) && (!m || r.score > m.score)) m = r;
      }
    }
    if (!m && seq.length >= 2) {
      for (const vi of cand) { const r = tryVerse(vi, seq); if (r && r.score >= 0.6 && r.pairs.length >= 2 && (!m || r.score > m.score)) m = r; }
    }
    if (!m && seq.length >= 3) {
      // 성경 전체에서: 첫 번호들이 든 구절만 훑는다
      const scan = new Set();
      for (let vi = 0; vi < wlc.verses.length; vi++) {
        const ws = wlc.verses[vi].words;
        let hit = 0;
        for (const x of ws) if (seq.includes(x.s)) hit++;
        if (hit >= Math.max(3, seq.length * 0.6)) scan.add(vi);
      }
      for (const vi of scan) { const r = tryVerse(vi, seq); if (r && r.score >= 0.7 && (!m || r.score > m.score)) m = r; }
    }
    if (!m) continue;
    cand.add(m.vi);
    for (let d = -2; d <= 3; d++) if (wlc.verses[m.vi + d]) cand.add(m.vi + d);
    prev = { vi: m.vi, next: Math.max(...m.pairs.map((p) => p[1])) + 1 };
    // 칸 너비: 이웃 번호와의 가운데까지
    const xs = row.nums.map((w) => (w.x0 + w.x1) / 2);
    const gap = xs.length > 1 ? Math.abs(xs[0] - xs[xs.length - 1]) / (xs.length - 1) : (row.nums[0].x1 - row.nums[0].x0) * 3;
    for (const [i, j] of m.pairs) {
      const c = xs[i];
      const left = i < xs.length - 1 ? (xs[i] + xs[i + 1]) / 2 : c - gap * 0.55;
      const right = i > 0 ? (xs[i - 1] + xs[i]) / 2 : c + gap * 0.55;
      fills.push({ li: row.li, x0: left, x1: right, wo: wlc.verses[m.vi].words[j], word: wlc.verses[m.vi].words[j].w, numBox: row.nums[i] });
    }
  }

  const gone = new Set();
  // 4) 번호 아래 칸: 번호 줄 아래 몇 줄 가운데, 칸마다 글자가 가장 큰 줄(모음 부호까지 있어 키가 크다)에 표를 주고
  //    표를 가장 많이 받은 줄 하나를 그 번호 줄의 히브리어 줄로 삼는다
  const colLines = (f) => {
    const nb = f.numBox, out = [];
    lines.forEach((l, li) => {
      if (li === f.li) return;
      const inCol = l.filter((w) => !gone.has(w) && !w.heb && inX(w, f.x0, f.x1) && w.y0 > nb.y1 - 2 && w.y0 - nb.y1 < (nb.y1 - nb.y0) * 9);
      if (!inCol.length) return;
      if (inCol.every((w) => /^[A-Za-z][A-Za-z.,'’-]*$/.test(w.text) && (w.conf ?? 0) >= 80)) return;   // 품사 표시·영어 뜻 줄
      out.push({ li, inCol, h: Math.max(...inCol.map((w) => w.y1 - w.y0)) });
    });
    return out;
  };
  const byRow = new Map();
  for (const f of fills) { if (!byRow.has(f.li)) byRow.set(f.li, []); byRow.get(f.li).push(f); }
  for (const fs of byRow.values()) {
    const vote = new Map();
    for (const f of fs) { const c = colLines(f).sort((a, b) => b.h - a.h)[0]; if (c) vote.set(c.li, (vote.get(c.li) || 0) + 1); }
    const tli = [...vote].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (tli == null) continue;
    for (const f of fs) {
      const c = colLines(f).find((c) => c.li === tli);
      if (!c) continue;
      for (const w of c.inCol) gone.add(w);
      // 같은 칸의 다른 줄에 남은 잡티(히브리어 글자를 잘못 읽은 것)도 지운다 — 한글·영어로 제대로 읽힌 것은 둔다
      const b = lineBox(c.inCol);
      lines[tli].push({ text: f.word.replace(/־$/, '-'), x0: Math.max(b.x0, f.x0), x1: Math.min(b.x1, f.x1), y0: b.y0, y1: b.y1, conf: 99, heb: true, wo: f.wo });
    }
  }

  // 5) 히브리어로 읽힌 조각들: 같은 줄의 조각을 오른쪽→왼쪽(읽는 순서)으로 늘어놓고
  //    후보 구절의 낱말 순서와 맞춰 본다(한 조각 = 낱말 하나 또는 마깝으로 이어진 두 낱말)
  const all = lines.flatMap((l, li) => l.map((w) => ({ w, li })));
  const rows = [];
  for (const t of toks.slice().sort((a, b) => a.y0 - b.y0)) {
    const r = rows.find((r) => vOverlap(r.box, t));
    if (r) { r.toks.push(t); r.box = { x0: Math.min(r.box.x0, t.x0), y0: Math.min(r.box.y0, t.y0), x1: Math.max(r.box.x1, t.x1), y1: Math.max(r.box.y1, t.y1) }; }
    else rows.push({ toks: [t], box: { x0: t.x0, y0: t.y0, x1: t.x1, y1: t.y1 } });
  }
  const align = (keys, ws) => {
    // dp[i][j]: 조각 i개, 낱말 j개까지 썼을 때 최고 점수
    const m = keys.length, n = ws.length;
    const dp = Array.from({ length: m + 1 }, () => new Float32Array(n + 1));
    const bk = Array.from({ length: m + 1 }, () => new Int8Array(n + 1));
    for (let i = 1; i <= m; i++) for (let j = 0; j <= n; j++) {
      let v = dp[i - 1][j], b = 0;                             // 조각 버림
      if (j && dp[i][j - 1] > v) { v = dp[i][j - 1]; b = 1; }  // 낱말 건너뜀
      if (j) { const s = dp[i - 1][j - 1] + Math.max(0, sim(keys[i - 1], ws[j - 1].k) - 0.4); if (s > v) { v = s; b = 2; } }
      if (j > 1) { const s = dp[i - 1][j - 2] + Math.max(0, sim(keys[i - 1], ws[j - 2].k + ws[j - 1].k) - 0.4) - 0.02; if (s > v) { v = s; b = 3; } }
      dp[i][j] = v; bk[i][j] = b;
    }
    const out = [];
    for (let i = m, j = n; i > 0 && j >= 0;) {
      const b = bk[i][j];
      if (b === 0) i--; else if (b === 1) j--;
      else if (b === 2) { out.push([i - 1, [j - 1]]); i--; j--; }
      else { out.push([i - 1, [j - 2, j - 1]]); i--; j -= 2; }
    }
    return { score: dp[m][n], pairs: out.reverse() };
  };
  const candList = [...cand].sort((a, b) => a - b);
  for (const r of rows) {
    const ts = r.toks.sort((a, b) => b.x0 - a.x0);
    const keys = ts.map((t) => t.keys.join(''));
    let bestA = null;
    for (const vi of candList) {
      const ws = wlc.verses[vi].words.concat(wlc.verses[vi + 1] && candList.includes(vi + 1) ? wlc.verses[vi + 1].words : []);
      const a = align(keys, ws);
      if (!bestA || a.score > bestA.score) bestA = { ...a, ws };
    }
    if (!bestA || bestA.score < 0.25) continue;
    for (const [ti, js] of bestA.pairs) {
      const t = ts[ti], key = keys[ti];
      const wk = js.map((j) => bestA.ws[j].k).join('');
      const sc = sim(key, wk);
      if (sc < (key.length <= 2 ? 0.99 : 0.5)) continue;
      let text = '';
      for (const j of js) text += (text && !text.endsWith('־') ? ' ' : '') + bestA.ws[j].w;
      if (lines.some((l) => l.some((w) => w.heb && xOverlap(w, t) && Math.abs((w.y0 + w.y1) / 2 - (t.y0 + t.y1) / 2) < (t.y1 - t.y0) * 1.5))) continue;   // 이미 번호로 채운 칸
      const hit = all.filter(({ w }) => !gone.has(w) && !w.heb && vOverlap(w, t) && xOverlap(w, t));
      if (!hit.length) continue;
      if (hit.some(({ w }) => syl(w.text) >= 2 && (w.conf ?? 0) >= 60 || syl(w.text) === 1 && (w.conf ?? 0) >= 85)) continue;
      // 바꾸는 자리 앞뒤의 괄호·쉼표는 살린다
      hit.sort((a, b) => a.w.x0 - b.w.x0);
      const lead = (hit[0].w.text.match(/^[(\[]+/) || [''])[0];
      const trail = (hit[hit.length - 1].w.text.match(/[,.;:]+$/) || [''])[0];
      for (const { w } of hit) gone.add(w);
      const b = { x0: Math.min(...hit.map((h) => h.w.x0)), x1: Math.max(...hit.map((h) => h.w.x1)), y0: Math.min(...hit.map((h) => h.w.y0)), y1: Math.max(...hit.map((h) => h.w.y1)) };
      const li = hit[0].li;
      if (lead) lines[li].push({ text: lead, x0: b.x0 - 1, x1: b.x0, y0: b.y0, y1: b.y1, conf: 90 });
      lines[li].push({ text: text.replace(/־$/, '-'), x0: b.x0, x1: b.x1, y0: b.y0, y1: b.y1, conf: 95, heb: true, wo: bestA.ws[js[js.length - 1]], wo0: bestA.ws[js[0]] });
      if (trail) lines[li].push({ text: trail, x0: b.x1, x1: b.x1 + 1, y0: b.y0, y1: b.y1, conf: 90 });
    }
  }
  // 6) 사이 메우기: 한 줄에서 성경 낱말 둘 사이에 빠진 낱말이 있고 그 자리에 잡티가 있으면 빠진 낱말로
  const solid = (w) => syl(w.text) >= 2 && (w.conf ?? 0) >= 60 || syl(w.text) === 1 && (w.conf ?? 0) >= 85 || /^[A-Za-z][A-Za-z'’.,-]*$/.test(w.text) && (w.conf ?? 0) >= 80 || /^[\s.,;:()\[\]"“”'‘’…·-]*$/.test(w.text);
  for (const l of lines) {
    const hs = l.filter((w) => w.heb && w.wo && !gone.has(w)).sort((a, b) => b.x0 - a.x0);
    if (!hs.length) continue;
    const wid = hs.reduce((a, w) => a + (w.x1 - w.x0), 0) / hs.length;
    const junkIn = (xa, xb) => l.filter((w) => !w.heb && !gone.has(w) && !solid(w) && (w.x0 + w.x1) / 2 > xa && (w.x0 + w.x1) / 2 < xb);
    const clusters = (ws) => { const s = ws.slice().sort((a, b) => b.x0 - a.x0), out = []; for (const w of s) { const c = out[out.length - 1]; if (c && c[c.length - 1].x0 - w.x1 < wid * 0.35) c.push(w); else out.push([w]); } return out; };
    const put = (ws, wo) => {
      for (const w of ws) gone.add(w);
      const b = lineBox(ws), s = ws.slice().sort((p, q) => p.x0 - q.x0);
      const lead = (s[0].text.match(/^[(\[]+/) || [''])[0], trail = (s[s.length - 1].text.match(/[,.;:]+$/) || [''])[0];
      if (lead) l.push({ text: lead, x0: b.x0 - 1, x1: b.x0, y0: b.y0, y1: b.y1, conf: 90 });
      l.push({ text: wo.w.replace(/־$/, '-'), ...b, conf: 90, heb: true, wo });
      if (trail) l.push({ text: trail, x0: b.x1, x1: b.x1 + 1, y0: b.y0, y1: b.y1, conf: 90 });
    };
    const gaps = [];
    for (let i = 0; i + 1 < hs.length; i++) {
      const a = hs[i], b = hs[i + 1];
      const ga = (a.wo.g), gb = (b.wo0 || b.wo).g;
      const k = gb - ga - 1;
      if (k >= 1 && k <= 3) gaps.push({ ws: junkIn(b.x1 - 2, a.x0 + 2), from: ga + 1, k });
    }
    // 맨 오른쪽(구절 첫머리) 앞
    const f0 = hs[0], g0 = (f0.wo0 || f0.wo).g, start = wlc.verses[(f0.wo0 || f0.wo).vi].off;
    if (g0 - start >= 1 && g0 - start <= 2) gaps.push({ ws: junkIn(f0.x1 - 2, f0.x1 + wid * 1.6 * (g0 - start)), from: start, k: g0 - start });
    // 맨 왼쪽(뒤에 이어지는 낱말) 뒤: 바로 붙은 잡티 한두 덩어리
    const fl = hs[hs.length - 1], gl = fl.wo.g;
    for (const k of [1, 2]) {
      const ws = junkIn(fl.x0 - wid * 1.6 * k, fl.x0 + 2);
      if (ws.length && clusters(ws).length === k && wlc.flat[gl + k]) { gaps.push({ ws, from: gl + 1, k }); break; }
    }
    for (const gp of gaps) {
      if (!gp.ws.length) continue;
      const cs = clusters(gp.ws);
      if (gp.k === 1) put(gp.ws, wlc.flat[gp.from]);
      else if (cs.length === gp.k) cs.forEach((c, i) => put(c, wlc.flat[gp.from + i]));
    }
  }
  return lines.map((l) => l.filter((w) => !gone.has(w)).map(({ heb, wo, wo0, ...w }) => w).sort((p, q) => p.x0 - q.x0)).filter((l) => l.length);
}
