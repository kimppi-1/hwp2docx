#!/usr/bin/env node
// 사용법: node cli-docx.mjs 입력.docx [출력.hwpx]
import fs from 'node:fs';
import { docxToHwpx } from './src/index.mjs';
const [input, out] = process.argv.slice(2);
if (!input) { console.error('사용법: node cli-docx.mjs 입력.docx [출력.hwpx]'); process.exit(1); }
const { hwpx, report } = docxToHwpx(new Uint8Array(fs.readFileSync(input)));
const dest = out || input.replace(/\.docx$/i, '') + '.hwpx';
fs.writeFileSync(dest, hwpx);
console.log(`${input} → ${dest}`);
console.log(`  문단 ${report.stats.paragraphs}개, 구역 ${report.stats.sections}개`);
console.log(`  사용 글꼴: ${report.fonts.join(', ')}`);
for (const a of report.approximations) console.log(`   - ${a.msg} (${a.count}곳)`);
