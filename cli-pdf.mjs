#!/usr/bin/env node
// PDF → 한글(.hwpx) (또는 --docx 로 워드)
// 사용: node cli-pdf.mjs 입력.pdf [출력이름(확장자 없이)] [--docx] [--for-libreoffice]
import fs from 'node:fs';
import path from 'node:path';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { pdfToHwpx, pdfToDocx } from './src/pdf-convert.mjs';
const args = process.argv.slice(2);
const files = args.filter(a => !a.startsWith('--'));
if (!files[0]) { console.error('사용: node cli-pdf.mjs 입력.pdf [출력이름] [--docx] [--for-libreoffice]'); process.exit(1); }
const out = files[1] ?? files[0].replace(/\.pdf$/i, '');
const bytes = new Uint8Array(fs.readFileSync(files[0]));
const cMapUrl = path.join(path.dirname(new URL(import.meta.url).pathname), 'node_modules/pdfjs-dist/cmaps/');
try {
  const r = args.includes('--docx')
    ? await pdfToDocx(bytes, pdfjs, { cMapUrl, target: args.includes('--for-libreoffice') ? 'libreoffice' : 'word' })
    : await pdfToHwpx(bytes, pdfjs, { cMapUrl });
  const file = out + (r.docx ? '.docx' : '.hwpx');
  fs.writeFileSync(file, r.docx ?? r.hwpx);
  console.log(`${path.basename(files[0])} → ${path.basename(file)}  (${r.report.stats.pages}쪽, 문단 ${r.report.stats.paragraphs}개, 글꼴: ${r.report.fonts.join(', ')})`);
  for (const a of r.report.approximations) console.log(`  - ${a.msg} (${a.count})`);
} catch (e) {
  console.error(e.code === 'NO_TEXT' ? '글자가 들어 있지 않은 PDF입니다 (스캔하거나 그림으로 만든 PDF).' : e.code === 'PASSWORD' ? '암호가 걸린 PDF입니다.' : e.message);
  process.exit(1);
}
