import { parseHwp } from './hwp-parse.mjs';
import { buildDocx } from './docx-write.mjs';
import { readDocx } from './docx-read.mjs';
import { buildHwpx } from './hwpx-write.mjs';

// hwp 파일 내용(Uint8Array) → { docx: Uint8Array, report }
export function hwpToDocx(bytes, opts = {}) {
  const doc = parseHwp(bytes);
  return buildDocx(doc, opts);
}
// docx 파일 내용(Uint8Array) → { hwpx: Uint8Array, report }
export function docxToHwpx(bytes, opts = {}) {
  return buildHwpx(readDocx(bytes), opts);
}
export { parseHwp, buildDocx, readDocx, buildHwpx };

// .hwpx → 워드: rhwp 엔진으로 .hwp 로 바꾼 뒤 위 변환기를 쓴다 (엔진은 처음 한 번 받음)
export async function hwpxToDocx(bytes, opts = {}) {
  const { hwpxToHwp } = await import('./rhwp-bridge.mjs');
  return hwpToDocx(await hwpxToHwp(bytes), opts);
}
// 워드 → .hwp (옛 한글 버전용): .hwpx 를 만든 뒤 rhwp 엔진으로 .hwp 로 저장
export async function docxToHwp(bytes, opts = {}) {
  const r = docxToHwpx(bytes, opts);
  const { hwpxToHwp } = await import('./rhwp-bridge.mjs');
  return { ...r, hwp: await hwpxToHwp(r.hwpx) };
}
