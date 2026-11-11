// 색 표시 글 → 서식 틀을 입힌 한글(.hwpx)·워드(.docx)
// 표시법 (한 줄 = 한 문단, 빈 줄 = 빈 문단):
//   {파:…} 파랑   {빨:…} 빨강   {초:…} 초록   {주:…} 주황
//   {굵:…} 검은 굵은 글씨   {파굵:…} {빨굵:…} {초굵:…} 굵게 + 색
//   영문 표기 {B:…} {R:…} {G:…} {O:…} {*:…} {B*:…} 도 됨
import { STYLE_TEMPLATE } from './style-template.mjs';
import { buildDocx } from './docx-write.mjs';
import { buildHwpx } from './hwpx-write.mjs';

const COLORS = { '파': '0000FF', '빨': 'FF0000', '초': '008000', '주': 'FF6600', 'B': '0000FF', 'R': 'FF0000', 'G': '008000', 'O': 'FF6600' };

export function parseStyled(text) {
  const lines = text.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n');
  return lines.map((line) => {
    const runs = []; const re = /\{([파빨초주BRGO]?)(굵|\*)?:([^{}]*)\}/g;
    let last = 0, m;
    while ((m = re.exec(line))) {
      if (m.index > last) runs.push({ text: line.slice(last, m.index), color: '000000', bold: false });
      runs.push({ text: m[3], color: COLORS[m[1]] ?? '000000', bold: !!m[2] });
      last = re.lastIndex;
    }
    if (last < line.length) runs.push({ text: line.slice(last), color: '000000', bold: false });
    return runs.filter(r => r.text.length);
  });
}

// 한글 파일 모델(hwp-parse 형식) — 워드 변환기에 그대로 넣는다
function hwpModel(paras) {
  const t = JSON.parse(JSON.stringify(STYLE_TEMPLATE));
  const base = t.charShapes[0];
  const key = (c) => `${c.color}|${c.bold ? 1 : 0}|${c.size}|${c.face.join()}|${c.underline}|${c.italic ? 1 : 0}`;
  const cache = new Map(t.charShapes.map((c, i) => [key(c), i]).reverse());
  const cs = (color, bold) => {
    const want = { ...base, color, bold, underline: 0, italic: false };
    const k = key(want);
    if (!cache.has(k)) { t.charShapes.push(want); cache.set(k, t.charShapes.length - 1); }
    return cache.get(k);
  };
  const black = cs('000000', false);
  t.sections = [{ paras: paras.map((runs, i) => {
    const items = i === 0 ? t.lead.map(x => ({ ...x, cs: black })) : [];
    let pos = i === 0 ? 16 : 0;
    for (const r of runs) { items.push({ t: 'text', text: r.text, cs: cs(r.color, r.bold), pos }); pos += r.text.length; }
    return { paraShape: t.bodyParaShape, style: 0, divide: 0, items, lineSegs: [{ pos: 0, y: 0, height: 1000, textHeight: 1000, baseline: 850, gap: 600, x: 0, width: 0 }], endCharShape: runs.length ? cs(runs.at(-1).color, runs.at(-1).bold) : black };
  }) }];
  // 줄배치 정보는 첫 줄 기준선(글자 크기의 0.85)만 넣는다 — 워드 쪽에서 글자 높이를 한글과 맞추는 데 쓰인다
  delete t.lead; delete t.bodyParaShape;
  return t;
}

// 워드 모델(docx-read 형식) — 한글 쓰개에 '한글 값 그대로' 모드로 넣는다
function wordModel(paras) {
  const pg = STYLE_TEMPLATE.lead.find(x => x.ctrl.id === 'secd').ctrl.page;
  const ps = STYLE_TEMPLATE.paraShapes[STYLE_TEMPLATE.bodyParaShape];
  const tw = (h) => h / 5;
  const font = { eastAsia: '함초롬바탕', ascii: '함초롬바탕', hAnsi: '함초롬바탕', cs: '함초롬바탕' };
  const rpr = (color, bold) => ({ fonts: font, sz: 20, color, b: bold });
  const ppr = { jc: ps.align === 0 ? 'both' : ps.align === 3 ? 'center' : 'left', spacing: { before: 0, after: 0 }, hwpLine: { type: 'PERCENT', value: ps.lineSpacing } };
  return {
    sumSpacing: true, defaultTab: 800,
    sections: [{
      // 한글: 위 여백 = 종이 → 머리말, 머리말 = 머리말 높이. 워드식으로 넘기면 hwpx-write가 되돌린다.
      page: { w: tw(pg.width), h: tw(pg.height), left: tw(pg.left), right: tw(pg.right), top: tw(pg.top + pg.header), header: tw(pg.top), bottom: tw(pg.bottom + pg.footer), footer: tw(pg.bottom), gutter: 0, colGap: 0, cols: 1, landscape: false },
      blocks: paras.map(runs => ({ k: 'p', ppr, markR: rpr('000000', false), runs: runs.map(r => ({ t: 'text', text: r.text, rpr: rpr(r.color, r.bold) })) })),
    }],
  };
}

export function styledToHwpx(text) { return buildHwpx(wordModel(parseStyled(text)), { native: true, fixSpaces: false, alignBaselines: false }).hwpx; }
export function styledToDocx(text) { return buildDocx(hwpModel(parseStyled(text)), { keepPageBreaks: false }).docx; }
