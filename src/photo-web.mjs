// 브라우저에서 사진 → 한글: 그림 해독은 캔버스, 글자 인식은 tesseract.js (한국어+영어, 처음 한 번 언어 자료를 받음)
import { readPhotos } from './photo-read.mjs';
import { bookModelToHwpx } from './pdf-convert.mjs';

const MAX_SIDE = 3200;   // 휴대폰 사진(1200만 화소)을 이 크기로 줄여 다룬다

export async function decodeImageBrowser(bytes, name) {
  const type = /\.png$/i.test(name) ? 'image/png' : /\.webp$/i.test(name) ? 'image/webp' : 'image/jpeg';
  let bmp;
  try { bmp = await createImageBitmap(new Blob([bytes], { type }), { imageOrientation: 'from-image' }); }
  catch { const e = new Error('IMAGE_DECODE'); e.code = 'IMAGE_DECODE'; throw e; }
  const s = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * s), h = Math.round(bmp.height * s);
  const cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  return { w, h, data: ctx.getImageData(0, 0, w, h).data };
}

let workerP = null;
async function worker(lang) {
  if (!workerP) workerP = (async () => {
    const Tesseract = (await import('tesseract.js')).default ?? (await import('tesseract.js'));
    const w = await Tesseract.createWorker(lang || 'kor+eng');
    await w.setParameters({ tessedit_pageseg_mode: '6', preserve_interword_spaces: '1' });
    return w;
  })();
  return workerP;
}
export async function ocrBrowser(png) {
  const w = await worker();
  const r = await w.recognize(new Blob([png], { type: 'image/png' }), {}, { blocks: true });
  const lines = [];
  for (const b of r.data.blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) {
    const words = (l.words || []).filter(x => x.text?.trim()).map(x => ({ text: x.text, x0: x.bbox.x0, y0: x.bbox.y0, x1: x.bbox.x1, y1: x.bbox.y1 }));
    if (!words.length) continue;
    lines.push({ text: words.map(x => x.text).join(' '), words, x0: Math.min(...words.map(x => x.x0)), y0: Math.min(...words.map(x => x.y0)), x1: Math.max(...words.map(x => x.x1)), y1: Math.max(...words.map(x => x.y1)) });
  }
  return lines;
}

// files: [{ name, bytes }] — 쪽 순서대로(파일 이름 순으로 정렬해 넘기면 됨)
export async function photosToHwpx(files, opts = {}) {
  const m = await readPhotos(files, { decode: decodeImageBrowser, ocr: ocrBrowser, ...opts });
  return { hwpx: bookModelToHwpx(m), report: m.report, paragraphs: m.paras.length };
}
