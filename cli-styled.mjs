#!/usr/bin/env node
// 색 표시 글(.txt) → 서식 틀을 입힌 한글 파일(.hwpx)과 워드 파일(.docx)
// 사용: node cli-styled.mjs 원고.txt [출력이름(확장자 없이)] [--hwpx-only|--docx-only]
import fs from 'fs';
import path from 'path';
import { styledToHwpx, styledToDocx } from './src/styled.mjs';
const args = process.argv.slice(2);
const files = args.filter(a => !a.startsWith('--'));
if (!files[0]) { console.error('사용: node cli-styled.mjs 원고.txt [출력이름] [--hwpx-only|--docx-only]'); process.exit(1); }
const text = fs.readFileSync(files[0], 'utf8');
const out = files[1] ?? path.join(path.dirname(files[0]), path.basename(files[0], path.extname(files[0])));
if (!args.includes('--docx-only')) { fs.writeFileSync(out + '.hwpx', styledToHwpx(text)); console.log('→', out + '.hwpx'); }
if (!args.includes('--hwpx-only')) { fs.writeFileSync(out + '.docx', styledToDocx(text)); console.log('→', out + '.docx'); }
