import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

export function normalizeText(text) {
  return (text || '').replace(/\u0000/g, ' ').replace(/\s+/g, ' ').trim();
}

export async function extractPages(buffer, { maxPages = 0 } = {}) {
  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(buffer) });
  const pdf = await loadingTask.promise;

  const total = pdf.numPages;
  const limit = !maxPages || maxPages <= 0 ? total : Math.min(total, maxPages);

  const pages = [];
  for (let i = 1; i <= limit; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const text = content.items.map((it) => (typeof it.str === 'string' ? it.str : '')).join(' ');
    pages.push({ pageNumber: i, text: normalizeText(text) });
  }

  return { pages, numPages: total };
}

export function isProbablyScanned(pages) {
  const joined = pages.map((p) => p.text).join(' ').trim();
  if (!joined) return true;
  if (joined.length > 2000) return false;
  const nonEmpty = pages.filter((p) => (p.text || '').length >= 50).length;
  return nonEmpty / Math.max(1, pages.length) < 0.2;
}

export function chunkPages(pages, { docId, targetChars = 3500, overlapChars = 300 } = {}) {
  const chunks = [];
  let buf = []; // {pageNumber, text}
  let bufLen = 0;

  const flush = () => {
    if (!buf.length) return;
    const pageStart = buf[0].pageNumber;
    const pageEnd = buf[buf.length - 1].pageNumber;
    const text = buf.map((p) => p.text).join('\n\n').trim();

    if (text) {
      chunks.push({
        id: `${docId}:${chunks.length}`,
        docId,
        pageStart,
        pageEnd,
        text,
      });
    }

    if (!overlapChars || overlapChars <= 0) {
      buf = [];
      bufLen = 0;
      return;
    }

    const tail = text.slice(-overlapChars);
    if (!tail.trim()) {
      buf = [];
      bufLen = 0;
      return;
    }

    buf = [{ pageNumber: pageEnd, text: tail }];
    bufLen = tail.length;
  };

  for (const p of pages) {
    if (!p.text) continue;
    buf.push(p);
    bufLen += p.text.length;
    if (bufLen >= targetChars) flush();
  }
  flush();

  return chunks;
}
