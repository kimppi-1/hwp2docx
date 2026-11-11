#!/usr/bin/env node
// 설교 원고(표시 글 .txt) → 설교 한글 파일(.hwpx)과 워드 파일(.docx)
// 사용: node cli-sermon.mjs 원고.txt [출력이름(확장자 없이)] [--hwpx-only|--docx-only]
import fs from 'fs';
import path from 'path';
import { sermonToHwpx, sermonToDocx } from './src/sermon.mjs';
const args = process.argv.slice(2);
const files = args.filter(a => !a.startsWith('--'));
if (!files[0]) { console.error('사용: node cli-sermon.mjs 원고.txt [출력이름] [--hwpx-only|--docx-only]'); process.exit(1); }
const text = fs.readFileSync(files[0], 'utf8');
const out = files[1] ?? path.join(path.dirname(files[0]), path.basename(files[0], path.extname(files[0])));
if (!args.includes('--docx-only')) { fs.writeFileSync(out + '.hwpx', sermonToHwpx(text)); console.log('→', out + '.hwpx'); }
if (!args.includes('--hwpx-only')) { fs.writeFileSync(out + '.docx', sermonToDocx(text)); console.log('→', out + '.docx'); }
