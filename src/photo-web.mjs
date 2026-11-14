// 브라우저에서 사진 → 한글: 그림 해독은 캔버스, 글자 인식은 tesseract.js (한국어+영어, 처음 한 번 언어 자료를 받음)
import { readPhotos } from './photo-read.mjs';
import { bookModelToHwpx } from './pdf-convert.mjs';

const MAX_SIDE = 3200;   // 휴대폰 사진(1200만 화소)을 이 크기로 줄여 다룬다

// 파일 앞머리로 그림 형식을 알아낸다 (확장자가 틀려도 되게)
export function sniffImage(b) {
  const a = (i, n) => String.fromCharCode(...b.subarray(i, i + n));
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (a(1, 3) === 'PNG') return 'image/png';
  if (a(0, 4) === 'GIF8') return 'image/gif';
  if (a(0, 2) === 'BM') return 'image/bmp';
  if (a(0, 4) === 'RIFF' && a(8, 4) === 'WEBP') return 'image/webp';
  if ((a(0, 4) === 'II*\0') || (a(0, 4) === 'MM\0*')) return 'image/tiff';
  if (a(4, 4) === 'ftyp') {
    const brand = a(8, 4);
    if (/^(avif|avis)$/.test(brand)) return 'image/avif';
    if (/^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(brand)) return 'image/heic';
  }
  return 'application/octet-stream';
}

const CDN_HEIC = 'https://cdn.jsdelivr.net/npm/heic-to@1.6.7/dist/heic-to.js';   // LGPL-3.0, 필요할 때만 받음
async function bitmapFrom(bytes, type) {
  if (type === 'image/heic') {
    // 아이폰 HEIC·HEIF: 브라우저가 못 여는 경우가 많아 heic-to(libheif)로 푼다
    const m = await import(/* @vite-ignore */ CDN_HEIC);
    return m.heicTo({ blob: new Blob([bytes], { type }), type: 'bitmap', options: { imageOrientation: 'from-image' } });
  }
  if (type === 'image/tiff') {
    // TIFF(스캐너): UTIF(MIT)로 첫 쪽을 RGBA로
    const UTIF = (await import('utif2')).default;
    const ifds = UTIF.decode(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const page = ifds.find(f => f.width && f.height) || ifds[0];
    UTIF.decodeImage(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), page);
    const rgba = UTIF.toRGBA8(page);
    return createImageBitmap(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, page.width * page.height * 4), page.width, page.height));
  }
  try { return await createImageBitmap(new Blob([bytes], { type }), { imageOrientation: 'from-image' }); }
  catch {
    // 일부 브라우저: 옵션 없이, 또는 <img>로
    try { return await createImageBitmap(new Blob([bytes], { type })); } catch {}
    const url = URL.createObjectURL(new Blob([bytes], { type }));
    try {
      const img = new Image(); img.decoding = 'async'; img.src = url;
      await img.decode();
      return img;
    } finally { setTimeout(() => URL.revokeObjectURL(url), 5000); }
  }
}

export async function decodeImageBrowser(bytes, name) {
  let type = sniffImage(bytes);
  if (type === 'application/octet-stream') type = /\.png$/i.test(name) ? 'image/png' : /\.hei[cf]$/i.test(name) ? 'image/heic' : /\.tiff?$/i.test(name) ? 'image/tiff' : 'image/jpeg';
  let bmp;
  try { bmp = await bitmapFrom(bytes, type); }
  catch (err) {
    // HEIC인데 브라우저가 원래 열 수 있는 경우(사파리) 등을 한 번 더
    try { bmp = await createImageBitmap(new Blob([bytes])); }
    catch { const e = new Error(`IMAGE_DECODE (${type}): ${err?.message || err}`); e.code = 'IMAGE_DECODE'; throw e; }
  }
  const W0 = bmp.width || bmp.naturalWidth, H0 = bmp.height || bmp.naturalHeight;
  const s = Math.min(1, MAX_SIDE / Math.max(W0, H0));
  const w = Math.round(W0 * s), h = Math.round(H0 * s);
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
    const w = await Tesseract.createWorker(lang || 'kor');
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
