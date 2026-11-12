// 시험 문서 전체를 변환 → 워드/한글로 PDF 인쇄 → 원본 PDF와 줄·그림 단위로 대조해 표로 출력한다.
// node tools/check-all.mjs [--skip-render]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { hwpToDocx, docxToHwpx } from '../src/index.mjs';
import { pdfToHwpx, pdfToDocx } from '../src/pdf-convert.mjs';

const skipRender = process.argv.includes('--skip-render');
const outDir = path.resolve('test-docs/out');
fs.mkdirSync(outDir, { recursive: true });
const cMapUrl = path.resolve('vendor/pdfjs/cmaps') + '/';

const jobs = [];

// 1. HWP -> DOCX
const hwpDir = path.resolve('test-docs/hwp-to-docx');
if (fs.existsSync(hwpDir)) {
  for (const f of fs.readdirSync(hwpDir).filter(x => x.endsWith('.hwp')).sort()) {
    const base = f.replace(/\.hwp$/i, '');
    const src = path.join(hwpDir, f);
    const origPdf = path.join(hwpDir, `${base}.원본-한글인쇄.pdf`);
    const outDocx = path.join(outDir, `${base}.docx`);
    const outPdf = path.join(outDir, `${base}(워드).pdf`);
    const { docx } = hwpToDocx(new Uint8Array(fs.readFileSync(src)));
    fs.writeFileSync(outDocx, docx);
    jobs.push({ kind: '한글→워드', name: f, outFile: outDocx, origPdf, outPdf, engine: 'word' });
  }
}

// 2. DOCX -> HWPX
const docxDir = path.resolve('test-docs/docx-to-hwpx');
if (fs.existsSync(docxDir)) {
  for (const f of fs.readdirSync(docxDir).filter(x => x.endsWith('.docx')).sort()) {
    const base = f.replace(/\.docx$/i, '');
    const src = path.join(docxDir, f);
    const origPdf = path.join(docxDir, `${base}.원본-워드인쇄.pdf`);
    const outHwpx = path.join(outDir, `${base}.hwpx`);
    const outPdf = path.join(outDir, `${base}(한글).pdf`);
    const { hwpx } = docxToHwpx(new Uint8Array(fs.readFileSync(src)));
    fs.writeFileSync(outHwpx, hwpx);
    jobs.push({ kind: '워드→한글', name: f, outFile: outHwpx, origPdf, outPdf, engine: 'hangul' });
  }
}

// 3. PDF -> HWPX
const pdfDir = path.resolve('test-docs/pdf-to-hwpx');
if (fs.existsSync(pdfDir)) {
  for (const f of fs.readdirSync(pdfDir).filter(x => x.endsWith('.pdf')).sort()) {
    const base = f.replace(/\.pdf$/i, '');
    const src = path.join(pdfDir, f);
    const outHwpx = path.join(outDir, `${base}.hwpx`);
    const outPdf = path.join(outDir, `${base}(한글).pdf`);
    const { hwpx } = await pdfToHwpx(new Uint8Array(fs.readFileSync(src)), pdfjs, { cMapUrl });
    fs.writeFileSync(outHwpx, hwpx);
    jobs.push({ kind: 'PDF→한글', name: f, outFile: outHwpx, origPdf: src, outPdf, engine: 'hangul' });
  }
}

if (!skipRender) {
  const wordFiles = jobs.filter(j => j.engine === 'word').map(j => j.outFile);
  if (wordFiles.length) {
    execFileSync('python', ['tools/render-word.py', ...wordFiles], { stdio: 'inherit' });
  }
  const hwpFiles = jobs.filter(j => j.engine === 'hangul').map(j => j.outFile);
  if (hwpFiles.length) {
    execFileSync('python', ['tools/render-hangul.py', ...hwpFiles], { stdio: 'inherit' });
  }
}

console.log('\n| 구분 | 문서 | 쪽수(원본/결과) | 줄(원본/결과) | 같은 쪽·같은 줄 | 색 일치 | 세로 차이(중앙/최대) | 가로 차이(중앙/최대) | 그림(원본/결과·차이) |');
console.log('|---|---|---|---|---|---|---|---|---|');
for (const j of jobs) {
  if (!fs.existsSync(j.origPdf) || !fs.existsSync(j.outPdf)) {
    console.log(`| ${j.kind} | ${j.name} | (인쇄본 없음) | - | - | - | - | - | - |`);
    continue;
  }
  const out = execFileSync('python', ['tools/compare-lines.py', j.origPdf, j.outPdf], { encoding: 'utf8' }).trim();
  const m1 = out.match(/쪽수 원본 (\d+) \/ 한글 (\d+), 줄 (\d+)\/(\d+), 같은 쪽·같은 내용 줄 (\d+) \((\d+)%\), 그중 색 같음 (\d+)/);
  const m2 = out.match(/세로 차이 중앙 ([\d.]+)pt 최대 ([\d.]+), 가로 차이 중앙 ([\d.]+) 최대 ([\d.]+)/);
  const m3 = out.match(/그림 (\d+)\/(\d+), 같은 쪽 (\d+)(?:, 세로 차이 중앙 ([\d.]+)pt 최대 ([\d.]+), 가로 차이 중앙 ([\d.]+) 최대 ([\d.]+))?/);
  if (m1) {
    const [, pa, pb, la, lb, same, pct, col] = m1;
    const dy = m2 ? `${m2[1]} / ${m2[2]}pt` : '-';
    const dx = m2 ? `${m2[3]} / ${m2[4]}pt` : '-';
    const im = m3 ? (m3[4] ? `${m3[1]}/${m3[2]} (${m3[4]}/${m3[5]}pt)` : `${m3[1]}/${m3[2]}`) : '-';
    console.log(`| ${j.kind} | ${j.name} | ${pa} / ${pb} | ${la} / ${lb} | ${same} (${pct}%) | ${col}/${same} | ${dy} | ${dx} | ${im} |`);
  } else {
    console.log(`| ${j.kind} | ${j.name} | ${out.replace(/\r?\n/g, ' ')} |`);
  }
}
