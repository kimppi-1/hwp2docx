#!/usr/bin/env node
// 사용법: node cli.mjs 입력.hwp [출력.docx] [--keep-line-breaks] [--free-page-breaks] [--for-libreoffice]
import fs from 'node:fs';
import path from 'node:path';
import { hwpToDocx } from './src/index.mjs';

const args = process.argv.slice(2);
const flags = new Set(args.filter(a => a.startsWith('--')));
const files = args.filter(a => !a.startsWith('--'));
if (!files.length) { console.error('사용법: node cli.mjs 입력.hwp [출력.docx] [--keep-line-breaks] [--free-page-breaks] [--for-libreoffice]'); process.exit(1); }
const input = files[0];
const output = files[1] ?? input.replace(/\.hwp$/i, '') + '.docx';
const { docx, report } = hwpToDocx(new Uint8Array(fs.readFileSync(input)), { keepPageBreaks: !flags.has('--free-page-breaks'), keepLineBreaks: flags.has('--keep-line-breaks'), target: flags.has('--for-libreoffice') ? 'libreoffice' : 'word' });
fs.writeFileSync(output, docx);
console.log(`${path.basename(input)} → ${path.basename(output)}`);
console.log(`  문단 ${report.stats.paragraphs}개, 표 ${report.stats.tables}개(칸 ${report.stats.cells}개)`);
console.log(`  사용 글꼴: ${report.fonts.join(', ')}`);
if (report.approximations.length) {
  console.log('  그대로 옮기지 못해 근사 처리한 항목:');
  for (const a of report.approximations) console.log(`   - ${a.msg} (${a.count}곳)`);
} else console.log('  근사 처리한 항목 없음');
