// PDF를 어떻게 읽었는지 문단·표 단위로 보여 준다.
// node tools/dump-pdf.mjs 문서.pdf [문단 수=40] [표마다 칸 수=12]
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readPdf } from '../src/pdf-read.mjs';
import fs from 'fs';
const r = await readPdf(new Uint8Array(fs.readFileSync(process.argv[2])), pdfjs);
console.log(JSON.stringify(r.report), 'spaceEm', JSON.stringify(r.spaceEm));
const txt = (p) => p.runs.map(x => x.text).join('');
for (const p of r.paras.slice(0, +process.argv[3] || 40)) {
  if (p.k === 'tbl') {
    console.log(`[표 left${p.left.toFixed(1)} cols ${p.cols.map(c => c.toFixed(0)).join(',')} rows ${p.rows.length} b${p.before.toFixed(1)}${p.pageBreak ? ' PB' : ''} head${p.headerRows}]`);
    for (const c of p.cells.slice(0, +process.argv[4] || 12)) console.log(`   r${c.row} c${c.col} ${c.rowSpan}x${c.colSpan} ${c.fill || ''} ${c.vAlign} mar${JSON.stringify(Object.values(c.mar).map(v => +v.toFixed(1)))} b:${['top', 'bottom', 'left', 'right'].map(e => c.borders[e] ? c.borders[e].w.toFixed(1) : '-').join('/')} | ${c.paras.map(q => `[${q.align} ${q.pct}%]` + txt(q)).join(' ¶ ').slice(0, 110)}`);
  } else console.log(`[${p.align} L${p.left.toFixed(1)} b${p.before.toFixed(1)} ${p.pct}% ${p.size}${p.pageBreak ? ' PB' : ''}] ${txt(p).slice(0, 80)}`);
}
