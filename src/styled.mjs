// 색 표시 글 → 서식 틀을 입힌 한글(.hwpx)·워드(.docx)
// 표시법 (한 줄 = 한 문단, 빈 줄 = 빈 문단):
//   {파:…} 파랑   {빨:…} 빨강   {초:…} 초록   {주:…} 주황
//   {굵:…} 검은 굵은 글씨   {파굵:…} {빨굵:…} {초굵:…} 굵게 + 색
//   영문 표기 {B:…} {R:…} {G:…} {O:…} {*:…} {B*:…} 도 됨
import { STYLE_TEMPLATE } from './style-template.mjs';
import { buildDocx } from './docx-write.mjs';
import { parseHwp } from './hwp-parse.mjs';
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

// 서식 틀: { faces, charShapes, paraShapes, …(한글 파일의 문서 정보), lead(구역·단 정의), bodyParaShape, baseCharShape }
// JSON으로 저장해 두었다가 다시 넘겨도 된다.
const clone = (o) => JSON.parse(JSON.stringify(o));

// 사용자의 한글(.hwp) 파일에서 서식 틀을 뽑는다 — 본문에서 가장 많이 쓰인 문단 모양·글자 모양과 쪽 설정을 쓴다. 글 내용은 담지 않는다.
export function templateFromHwp(bytes) {
  const doc = parseHwp(bytes);
  const paras = doc.sections[0]?.paras ?? [];
  const lead = (paras[0]?.items ?? []).filter(x => x.t === 'ctrl' && (x.ctrl.id === 'secd' || x.ctrl.id === 'cold'));
  if (!lead.some(x => x.ctrl.id === 'secd')) throw new Error('쪽 설정(구역 정의)을 찾지 못했습니다');
  const psCount = new Map(), csCount = new Map();
  for (const p of paras) {
    const n = p.items.filter(x => x.t === 'text').reduce((a, x) => a + x.text.length, 0);
    psCount.set(p.paraShape, (psCount.get(p.paraShape) || 0) + n + 1);
    for (const x of p.items) if (x.t === 'text') csCount.set(x.cs, (csCount.get(x.cs) || 0) + x.text.length);
  }
  const top = (m, d) => [...m].sort((a, b) => b[1] - a[1])[0]?.[0] ?? d;
  const t = { ...doc };
  delete t.sections;
  t.lead = lead.map(x => ({ t: 'ctrl', ctrl: x.ctrl, cs: 0, pos: 0 }));
  t.bodyParaShape = top(psCount, 0);
  // 본문 글자 모양: 가장 많이 쓰인 '검은 글자' 모양(없으면 가장 많이 쓰인 모양)
  const blackCs = new Map([...csCount].filter(([i]) => (doc.charShapes[i]?.color ?? '000000').toUpperCase() === '000000'));
  t.baseCharShape = top(blackCs.size ? blackCs : csCount, 0);
  return clone(t);
}

const ALIGN_HWP = ['both', 'left', 'right', 'center', 'distribute', 'distribute'];
const LINE_HWP = ['PERCENT', 'FIXED', 'PERCENT', 'AT_LEAST'];
const faceName = (t, c) => { const f = t.faces?.[0]?.[c.face[0]]; return (typeof f === 'string' ? f : f?.name) || '함초롬바탕'; };

// 한글 파일 모델(hwp-parse 형식) — 워드 변환기에 그대로 넣는다
function hwpModel(paras, tpl) {
  const t = clone(tpl);
  const base = t.charShapes[t.baseCharShape ?? 0];
  const key = (c) => `${c.color}|${c.bold ? 1 : 0}|${c.size}|${c.face.join()}|${c.underline}|${c.italic ? 1 : 0}|${c.ratio.join()}|${c.spacing.join()}`;
  const cache = new Map(t.charShapes.map((c, i) => [key(c), i]).reverse());
  const cs = (color, bold) => {
    const want = { ...base, color, bold, underline: 0, italic: false };
    const k = key(want);
    if (!cache.has(k)) { t.charShapes.push(want); cache.set(k, t.charShapes.length - 1); }
    return cache.get(k);
  };
  const black = cs(base.color && base.color.toUpperCase() !== '000000' ? '000000' : base.color || '000000', false);
  // 줄배치 정보는 첫 줄 기준선(글자 크기의 0.85)만 넣는다 — 워드 쪽에서 글자 높이를 한글과 맞추는 데 쓰인다
  const seg = { pos: 0, y: 0, height: base.size, textHeight: base.size, baseline: Math.round(base.size * 0.85), gap: Math.round(base.size * 0.6), x: 0, width: 0 };
  t.sections = [{ paras: paras.map((runs, i) => {
    const items = i === 0 ? t.lead.map(x => ({ ...x, cs: black })) : [];
    let pos = i === 0 ? 8 * t.lead.length : 0;
    for (const r of runs) { items.push({ t: 'text', text: r.text, cs: cs(r.color, r.bold), pos }); pos += r.text.length; }
    return { paraShape: t.bodyParaShape, style: 0, divide: 0, items, lineSegs: [{ ...seg }], endCharShape: runs.length ? cs(runs.at(-1).color, runs.at(-1).bold) : black };
  }) }];
  delete t.lead; delete t.bodyParaShape; delete t.baseCharShape;
  return t;
}

// 워드 모델(docx-read 형식) — 한글 쓰개에 '한글 값 그대로' 모드로 넣는다
function wordModel(paras, tpl) {
  const pg = tpl.lead.find(x => x.ctrl.id === 'secd').ctrl.page;
  const ps = tpl.paraShapes[tpl.bodyParaShape];
  const c = tpl.charShapes[tpl.baseCharShape ?? 0];
  const tw = (h) => h / 5;
  const name = faceName(tpl, c);
  const font = { eastAsia: name, ascii: name, hAnsi: name, cs: name };
  const sizePt = c.size / 100;
  const rpr = (color, bold) => ({ fonts: font, sz: Math.round(c.size / 50), color, b: bold, w: c.ratio?.[0] ?? 100, spacing: c.spacing?.[0] ? Math.round(c.spacing[0] / 100 * sizePt * 20) : 0 });
  const lineType = LINE_HWP[ps.lineSpacingType] ?? 'PERCENT';
  const ppr = {
    jc: ALIGN_HWP[ps.align] ?? 'left',
    // 한글 내어쓰기(들여쓰기 음수)는 워드식 왼쪽 여백 + 첫 줄 음수로 넘긴다 (hwpx-write가 되돌림)
    ind: { left: tw(ps.left - Math.min(0, ps.indent)), right: tw(ps.right), first: tw(ps.indent) },
    spacing: { before: tw(ps.before), after: tw(ps.after) },
    hwpLine: { type: lineType, value: ps.lineSpacingType === 2 ? 160 : ps.lineSpacing },
  };
  return {
    sumSpacing: true, defaultTab: 800,
    sections: [{
      // 한글: 위 여백 = 종이 → 머리말, 머리말 = 머리말 높이. 워드식으로 넘기면 hwpx-write가 되돌린다.
      page: { w: tw(pg.width), h: tw(pg.height), left: tw(pg.left), right: tw(pg.right), top: tw(pg.top + pg.header), header: tw(pg.top), bottom: tw(pg.bottom + pg.footer), footer: tw(pg.bottom), gutter: tw(pg.gutter || 0), colGap: 0, cols: 1, landscape: !!pg.landscape },
      blocks: paras.map(runs => ({ k: 'p', ppr, markR: rpr('000000', false), runs: runs.map(r => ({ t: 'text', text: r.text, rpr: rpr(r.color, r.bold) })) })),
    }],
  };
}

// text: 색 표시 글, template: templateFromHwp()가 돌려준 틀(없으면 기본 틀)
export function styledToHwpx(text, template = STYLE_TEMPLATE) { return buildHwpx(wordModel(parseStyled(text), template), { native: true, fixSpaces: false, alignBaselines: false }).hwpx; }
export function styledToDocx(text, template = STYLE_TEMPLATE) { return buildDocx(hwpModel(parseStyled(text), template), { keepPageBreaks: false }).docx; }
export const DEFAULT_TEMPLATE = STYLE_TEMPLATE;

// 한글(.hwp) 파일의 글을 색 표시 글로 되돌린다 — 이미 쓴 원고를 불러와 고칠 때. 표·그림 속 글은 빠진다.
const COLOR_MARK = { '0000FF': '파', 'FF0000': '빨', '008000': '초', '2E7D32': '초', '00B050': '초', 'FF6600': '주' };
export function hwpToStyled(bytes) {
  const doc = parseHwp(bytes);
  const lines = [];
  for (const p of doc.sections.flatMap(s => s.paras)) {
    let line = '';
    for (const it of p.items) {
      if (it.t === 'br') { lines.push(line); line = ''; continue; }
      if (it.t === 'tab') { line += '\t'; continue; }
      if (it.t !== 'text') continue;
      const c = doc.charShapes[it.cs] ?? {};
      const mark = (COLOR_MARK[(c.color || '').toUpperCase()] ?? '') + (c.bold ? '굵' : '');
      const text = it.text.replace(/[{}]/g, m => (m === '{' ? '(' : ')'));
      line += mark ? `{${mark}:${text}}` : text;
    }
    lines.push(line);
  }
  return lines.join('\n');
}
