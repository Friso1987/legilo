// Office exports — Word (.docx) and PowerPoint (.pptx).
//
// Both exporters render the document off-screen exactly like the preview
// (same classes, same stylesheet), then walk the rendered DOM reading
// getComputedStyle per element. That way the active preview style — and any
// custom CSS — carries into the exported file as native, editable text.
// Diagrams and KaTeX math are rasterized to PNG; local images are read
// through the main process (file:// images taint a canvas in the renderer).
//
// PPTX slides reuse the exact 960×540 slide layout: each slide is rendered
// into an off-screen .slide-card, auto-shrunk with the same fitContent()
// the preview and presenter use, and every block is placed at its measured
// position. An overfull slide therefore exports just like Legilo shows it —
// scaled to fit — and text boxes additionally get PowerPoint's own
// "shrink text on overflow" autofit as a safety net.

import {
  Document, Packer, Paragraph, TextRun, ImageRun, ExternalHyperlink,
  Table, TableRow, TableCell, WidthType, BorderStyle, PageBreak,
  AlignmentType, HeadingLevel, LevelFormat, LineRuleType,
} from 'docx';
import PptxGenJS from 'pptxgenjs';

// ---------------------------------------------------------------------------
// Unit & color helpers (CSS px at 96 dpi)
// ---------------------------------------------------------------------------

const PX2TWIP = 15;        // 1px = 0.75pt = 15 twips
const PX2HALFPT = 1.5;     // docx font sizes are half-points
const PX2PT = 0.75;
const PX2IN = 1 / 96;

function fileUrlToPath(url) {
  let p = decodeURIComponent(url.replace(/^file:\/\//, '').replace(/[?#].*$/, ''));
  if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1); // file:///C:/… → C:/…
  return p;
}

function parseColor(css) {
  const m = (css || '').match(/rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:[ ,/]+([\d.]+))?\s*\)/);
  if (!m) return null;
  return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
}

// Composites translucent colors over `base` and returns "RRGGBB" (no '#'),
// or null for fully transparent.
function hexColor(css, base = { r: 255, g: 255, b: 255 }) {
  const c = parseColor(css);
  if (!c || c.a === 0) return null;
  const mix = (v, b) => Math.round(c.a * v + (1 - c.a) * b);
  return [mix(c.r, base.r), mix(c.g, base.g), mix(c.b, base.b)]
    .map((v) => v.toString(16).padStart(2, '0')).join('');
}

// First concrete family from a CSS font-family list.
const GENERIC_FONTS = new Set([
  '-apple-system', 'blinkmacsystemfont', 'system-ui', 'ui-monospace',
  'ui-serif', 'ui-sans-serif', 'ui-rounded', 'sans-serif', 'serif',
  'monospace', 'cursive', 'fantasy', 'emoji', 'math',
]);

function fontFace(cssFamily) {
  for (let f of (cssFamily || '').split(',')) {
    f = f.trim().replace(/^['"]|['"]$/g, '');
    if (f && !GENERIC_FONTS.has(f.toLowerCase())) return f;
  }
  return 'Calibri';
}

const ALIGN_DOCX = {
  center: AlignmentType.CENTER, right: AlignmentType.RIGHT,
  justify: AlignmentType.JUSTIFIED, left: AlignmentType.LEFT,
};

// Character-level style of an element, for text runs.
function runStyle(el, base) {
  const cs = getComputedStyle(el);
  const deco = cs.textDecorationLine || '';
  let bg = hexColor(cs.backgroundColor, base);
  return {
    font: fontFace(cs.fontFamily),
    sizePx: parseFloat(cs.fontSize),
    bold: (parseInt(cs.fontWeight, 10) || 400) >= 600,
    italic: cs.fontStyle === 'italic',
    strike: deco.includes('line-through'),
    underline: deco.includes('underline'),
    color: hexColor(cs.color, base) || '000000',
    bg,
    sup: cs.verticalAlign === 'super',
    sub: cs.verticalAlign === 'sub',
    transform: cs.textTransform,
  };
}

function applyTransform(text, transform) {
  if (transform === 'uppercase') return text.toUpperCase();
  if (transform === 'lowercase') return text.toLowerCase();
  return text;
}

// Static ::before/::after text (e.g. Typewriter's "## " heading prefix).
// Counter-based content (Academic numbering) is handled by the callers.
function pseudoText(el, which) {
  const content = getComputedStyle(el, which).content;
  const m = content && content.match(/^"((?:[^"\\]|\\.)*)"$/);
  return m ? m[1].replace(/\\(.)/g, '$1') : '';
}

// Academic preview style numbers h2/h3 via CSS counters, which computed
// styles can't resolve — replicate them while walking.
function headingPrefix(el, state) {
  const pseudo = pseudoText(el, '::before');
  if (pseudo) return pseudo;
  if (state.academic) {
    if (el.tagName === 'H2') { state.sec += 1; state.subsec = 0; return `${state.sec}. `; }
    if (el.tagName === 'H3') { state.subsec += 1; return `${state.sec}.${state.subsec} `; }
  }
  return '';
}

function waitForImages(el) {
  return Promise.all([...el.querySelectorAll('img')].map((img) => img.decode().catch(() => {})));
}

function dataUrlToBytes(dataUrl) {
  const b64 = dataUrl.slice(dataUrl.indexOf('base64,') + 7);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// ---------------------------------------------------------------------------
// Rasterization — SVG diagrams, KaTeX math, and odd image formats → PNG
// ---------------------------------------------------------------------------

// Draws an image data: URL onto a canvas at `scale`× and returns a PNG
// data: URL. data: sources don't taint the canvas.
function drawToPng(srcUrl, w, h, scale) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(w * scale));
      canvas.height = Math.max(1, Math.round(h * scale));
      const c2d = canvas.getContext('2d');
      c2d.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = () => reject(new Error('image failed to load'));
    img.src = srcUrl;
  });
}

// Inline SVG element (mermaid/d2 output) → PNG data: URL at its displayed size.
async function svgToPng(svg, scale = 2) {
  const rect = svg.getBoundingClientRect();
  const w = Math.max(1, rect.width);
  const h = Math.max(1, rect.height);
  const clone = svg.cloneNode(true);
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('width', w);
  clone.setAttribute('height', h);
  clone.style.maxWidth = '';
  clone.style.maxHeight = '';
  const xml = new XMLSerializer().serializeToString(clone);
  const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
  return { dataUrl: await drawToPng(url, w, h, scale), w, h };
}

// KaTeX renders with its own webfonts; to rasterize we build a foreignObject
// SVG carrying the whole KaTeX stylesheet with the woff2 fonts inlined as
// data: URLs (read via the main process — fetch can't touch file:).
let katexCssPromise = null;

function getKatexCss() {
  katexCssPromise ??= (async () => {
    let css = '';
    for (const sheet of document.styleSheets) {
      if (!(sheet.href || '').includes('/katex/')) continue;
      css = [...sheet.cssRules].map((r) => r.cssText).join('\n');
      break;
    }
    const urls = [...new Set(css.match(/url\("?file:[^)"]+\.woff2"?\)/g) || [])];
    for (const u of urls) {
      const fileUrl = u.replace(/^url\("?/, '').replace(/"?\)$/, '');
      const dataUrl = await window.legilo.readFileBinary(fileUrlToPath(fileUrl));
      if (dataUrl) css = css.replaceAll(u, `url("${dataUrl}")`);
    }
    return css;
  })();
  return katexCssPromise;
}

async function katexToPng(el, scale = 3) {
  const rect = el.getBoundingClientRect();
  // A little slack so sub-pixel rounding can't wrap or clip the formula.
  const w = Math.ceil(rect.width) + 8;
  const h = Math.ceil(rect.height) + 4;
  const cs = getComputedStyle(el);
  const css = await getKatexCss();
  const markup = new XMLSerializer().serializeToString(el);
  const xml =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
    `<foreignObject width="100%" height="100%">` +
    `<div xmlns="http://www.w3.org/1999/xhtml" style="font-size:${cs.fontSize};color:${cs.color};white-space:nowrap">` +
    `<style>${css.replaceAll('&', '&amp;').replaceAll('<', '&lt;')}</style>${markup}</div>` +
    `</foreignObject></svg>`;
  const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
  return { dataUrl: await drawToPng(url, w, h, scale), w, h };
}

function katexTex(el) {
  return el.querySelector('annotation')?.textContent?.trim() || el.textContent.trim();
}

// <img> → { dataUrl, type, w, h } at its displayed size, or null when the
// bytes can't be obtained (e.g. remote images, which CSP blocks fetching).
async function imgToOffice(img) {
  const rect = img.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width));
  const h = Math.max(1, Math.round(rect.height));
  let src = img.currentSrc || img.src || '';
  if (src.startsWith('file:')) {
    src = await window.legilo.readFileBinary(fileUrlToPath(src));
    if (!src) return null;
  }
  if (!src.startsWith('data:')) return null;
  const mime = src.slice(5, src.indexOf(';'));
  if (mime === 'image/png' || mime === 'image/jpeg' || mime === 'image/gif') {
    return { dataUrl: src, type: mime === 'image/png' ? 'png' : mime === 'image/gif' ? 'gif' : 'jpg', w, h };
  }
  // svg/webp/bmp → rasterize to PNG
  try {
    return { dataUrl: await drawToPng(src, w, h, 2), type: 'png', w, h };
  } catch (_) {
    return null;
  }
}

// The original URL behind a video embed (iframe or <video>).
function videoHref(el) {
  return el.tagName === 'IFRAME' ? el.src : (el.querySelector('iframe')?.src || el.src || '');
}

// Flattens an element's inline content into styled text segments; used for
// code blocks where line structure matters.
function textSegments(el, base, out = []) {
  for (const node of el.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      out.push({ text: node.textContent, style: runStyle(el, base) });
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      if (node.tagName === 'BR') out.push({ text: '\n', style: runStyle(el, base) });
      else textSegments(node, base, out);
    }
  }
  return out;
}

function segmentsToLines(segments) {
  const lines = [[]];
  for (const seg of segments) {
    const parts = seg.text.split('\n');
    parts.forEach((part, i) => {
      if (i > 0) lines.push([]);
      if (part) lines[lines.length - 1].push({ text: part, style: seg.style });
    });
  }
  // drop a trailing empty line (code blocks end with \n)
  while (lines.length > 1 && lines[lines.length - 1].length === 0) lines.pop();
  return lines;
}

// ---------------------------------------------------------------------------
// DOCX export — flowing document following the page view
// ---------------------------------------------------------------------------

// Standard page sizes in twips.
const DOCX_PAGES = {
  A4: { width: 11906, height: 16838 },
  Letter: { width: 12240, height: 15840 },
};

function docxSpacing(cs) {
  const fs = parseFloat(cs.fontSize) || 16;
  const lh = parseFloat(cs.lineHeight);
  return {
    before: Math.round((parseFloat(cs.marginTop) || 0) * PX2TWIP),
    after: Math.round((parseFloat(cs.marginBottom) || 0) * PX2TWIP),
    line: Number.isFinite(lh) ? Math.round((lh / fs) * 240) : 240,
    lineRule: LineRuleType.AUTO,
  };
}

function docxTextRun(text, s, extra = {}) {
  return new TextRun({
    text,
    font: s.font,
    size: Math.round(s.sizePx * PX2HALFPT),
    bold: s.bold,
    italics: s.italic,
    strike: s.strike,
    underline: s.underline ? {} : undefined,
    color: s.color,
    shading: s.bg ? { fill: s.bg } : undefined,
    superScript: s.sup || undefined,
    subScript: s.sub || undefined,
    ...extra,
  });
}

// Inline content of `el` → docx runs (TextRun / ImageRun / ExternalHyperlink).
async function docxRuns(el, base, out = []) {
  for (const node of el.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent.replace(/\s+/g, ' ');
      if (text) {
        const s = runStyle(el, base);
        out.push(docxTextRun(applyTransform(text, s.transform), s));
      }
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const tag = node.tagName;
    if (tag === 'BR') { out.push(new TextRun({ break: 1 })); continue; }
    if (tag === 'INPUT') { // task-list checkbox
      out.push(docxTextRun(node.checked ? '☑ ' : '☐ ', runStyle(el, base)));
      continue;
    }
    if (tag === 'IMG') {
      const pic = await imgToOffice(node);
      if (pic) {
        out.push(new ImageRun({
          type: pic.type, data: dataUrlToBytes(pic.dataUrl),
          transformation: { width: pic.w, height: pic.h },
        }));
      } else if (node.alt) {
        out.push(docxTextRun(`[${node.alt}]`, runStyle(el, base)));
      }
      continue;
    }
    if (node.classList.contains('katex-mathml')) continue; // hidden MathML copy
    if (node.classList.contains('katex') || node.classList.contains('katex-display')) {
      try {
        const pic = await katexToPng(node);
        out.push(new ImageRun({
          type: 'png', data: dataUrlToBytes(pic.dataUrl),
          transformation: { width: pic.w, height: pic.h },
        }));
      } catch (_) {
        out.push(docxTextRun(katexTex(node), { ...runStyle(el, base), italic: true }));
      }
      continue;
    }
    if (tag === 'A' && /^https?:/i.test(node.href)) {
      const children = await docxRuns(node, base, []);
      out.push(new ExternalHyperlink({ children, link: node.href }));
      continue;
    }
    await docxRuns(node, base, out);
  }
  return out;
}

// Border helper: computed border-bottom/left of a block → docx border entry.
function docxBorder(cs, side, base) {
  const width = parseFloat(cs[`border${side}Width`]) || 0;
  if (!width || cs[`border${side}Style`] === 'none') return null;
  return {
    style: cs[`border${side}Style`] === 'double' ? BorderStyle.DOUBLE : BorderStyle.SINGLE,
    size: Math.max(2, Math.round(width * PX2PT * 8)), // eighths of a point
    color: hexColor(cs[`border${side}Color`], base) || 'D1D9E0',
    space: 4,
  };
}

const HEADING_LEVELS = {
  H1: HeadingLevel.HEADING_1, H2: HeadingLevel.HEADING_2, H3: HeadingLevel.HEADING_3,
  H4: HeadingLevel.HEADING_4, H5: HeadingLevel.HEADING_5, H6: HeadingLevel.HEADING_6,
};

// Walks the block-level children of `container` and appends docx elements.
// `wctx` carries the white-point base, academic counters, ordered-list
// numbering configs, and blockquote modifiers (indent/border/shading).
async function docxBlocks(container, wctx, out = [], mod = {}) {
  for (const el of container.children) {
    await docxBlock(el, wctx, out, mod);
  }
  return out;
}

function paraOpts(cs, wctx, mod, extra = {}) {
  return {
    alignment: ALIGN_DOCX[cs.textAlign] || undefined,
    spacing: docxSpacing(cs),
    indent: mod.indent ? { left: mod.indent } : undefined,
    border: mod.border ? { left: mod.border } : undefined,
    shading: mod.shading ? { fill: mod.shading } : undefined,
    ...extra,
  };
}

async function docxBlock(el, wctx, out, mod) {
  const tag = el.tagName;
  const cls = el.classList;
  const cs = getComputedStyle(el);
  const base = wctx.base;

  if (cls.contains('page-break')) {
    out.push(new Paragraph({ children: [new PageBreak()] }));
    return;
  }

  if (cls.contains('diagram')) {
    const svg = el.querySelector('svg');
    if (svg) {
      const pic = await svgToPng(svg);
      out.push(new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: docxSpacing(cs),
        children: [new ImageRun({
          type: 'png', data: dataUrlToBytes(pic.dataUrl),
          transformation: { width: Math.round(pic.w), height: Math.round(pic.h) },
        })],
      }));
    } else { // diagram-error: emit the source as plain code text
      for (const line of el.textContent.split('\n')) {
        out.push(new Paragraph({
          children: [new TextRun({ text: line, font: 'Consolas', size: 20 })],
          spacing: { before: 0, after: 0 },
        }));
      }
    }
    return;
  }

  if (cls.contains('video-embed') || tag === 'VIDEO') {
    const href = videoHref(el);
    const label = `▶ ${href || 'video'}`;
    const s = { ...runStyle(el.closest('.markdown-body') || el, base), color: '0969DA' };
    out.push(new Paragraph({
      spacing: docxSpacing(cs),
      children: /^https?:/i.test(href)
        ? [new ExternalHyperlink({ children: [docxTextRun(label, s)], link: href })]
        : [docxTextRun(label, s)],
    }));
    return;
  }

  switch (tag) {
    case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6': {
      const prefix = headingPrefix(el, wctx);
      const runs = await docxRuns(el, base, []);
      const s = runStyle(el, base);
      out.push(new Paragraph(paraOpts(cs, wctx, mod, {
        heading: HEADING_LEVELS[tag],
        keepNext: true,
        border: docxBorder(cs, 'Bottom', base) ? { bottom: docxBorder(cs, 'Bottom', base) } : undefined,
        children: [
          ...(prefix ? [docxTextRun(applyTransform(prefix, s.transform), { ...s, color: s.color })] : []),
          ...runs,
        ],
      })));
      return;
    }
    case 'P': {
      const runs = await docxRuns(el, base, []);
      if (runs.length) out.push(new Paragraph(paraOpts(cs, wctx, mod, { children: runs })));
      return;
    }
    case 'UL': case 'OL':
      await docxList(el, wctx, out, mod, 0);
      return;
    case 'BLOCKQUOTE': {
      const inner = {
        indent: (mod.indent || 0) + Math.round((parseFloat(cs.paddingLeft) || 16) * PX2TWIP),
        border: docxBorder(cs, 'Left', base) || mod.border,
        shading: hexColor(cs.backgroundColor, base) || mod.shading,
      };
      await docxBlocks(el, wctx, out, inner);
      return;
    }
    case 'PRE': {
      const bg = hexColor(cs.backgroundColor, base) || 'F6F8FA';
      const lines = segmentsToLines(textSegments(el.querySelector('code') || el, base));
      lines.forEach((line, i) => {
        out.push(new Paragraph({
          shading: { fill: bg },
          spacing: {
            before: i === 0 ? Math.round((parseFloat(cs.marginTop) || 0) * PX2TWIP) : 0,
            after: i === lines.length - 1 ? Math.round((parseFloat(cs.marginBottom) || 16) * PX2TWIP) : 0,
            line: 240, lineRule: LineRuleType.AUTO,
          },
          indent: mod.indent ? { left: mod.indent } : undefined,
          children: line.length
            ? line.map((seg) => docxTextRun(seg.text, seg.style))
            : [new TextRun({ text: '' })],
        }));
      });
      return;
    }
    case 'TABLE':
      out.push(await docxTable(el, wctx));
      return;
    case 'HR': {
      const after = pseudoText(el, '::after');
      if (after) { // typewriter's "* * *"
        out.push(new Paragraph({
          alignment: AlignmentType.CENTER, spacing: docxSpacing(cs),
          children: [docxTextRun(after, runStyle(el, base))],
        }));
      } else {
        out.push(new Paragraph({
          spacing: docxSpacing(cs),
          border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: hexColor(cs.backgroundColor, base) || 'D1D9E0' } },
        }));
      }
      return;
    }
    case 'SECTION': case 'DIV':
      await docxBlocks(el, wctx, out, mod);
      return;
    default: {
      const runs = await docxRuns(el, base, []);
      if (runs.length) out.push(new Paragraph(paraOpts(cs, wctx, mod, { children: runs })));
    }
  }
}

async function docxList(listEl, wctx, out, mod, depth) {
  const ordered = listEl.tagName === 'OL';
  let numbering = null;
  if (ordered) {
    const ref = `legilo-ol-${wctx.numberingConfigs.length}`;
    const start = parseInt(listEl.getAttribute('start') || '1', 10);
    wctx.numberingConfigs.push({
      reference: ref,
      levels: Array.from({ length: 6 }, (_, l) => ({
        level: l,
        format: LevelFormat.DECIMAL,
        text: `%${l + 1}.`,
        alignment: AlignmentType.START,
        start: l === depth ? start : 1,
        style: { paragraph: { indent: { left: 720 * (l + 1), hanging: 360 } } },
      })),
    });
    numbering = { reference: ref, level: depth };
  }
  for (const li of listEl.children) {
    if (li.tagName !== 'LI') continue;
    const cs = getComputedStyle(li);
    const isTask = li.classList.contains('task-list-item');
    // Inline content first (nested lists become their own paragraphs below).
    const runs = await docxRunsForListItem(li, wctx.base);
    out.push(new Paragraph({
      children: runs,
      spacing: { before: 0, after: Math.round(4 * PX2TWIP), line: docxSpacing(cs).line, lineRule: LineRuleType.AUTO },
      indent: mod.indent ? { left: mod.indent + 720 * (depth + 1), hanging: isTask ? undefined : 360 } : undefined,
      bullet: !ordered && !isTask && !mod.indent ? { level: depth } : undefined,
      numbering: ordered && !mod.indent ? numbering : undefined,
      ...(isTask && !mod.indent ? { indent: { left: 720 * (depth + 1) } } : {}),
    }));
    for (const nested of li.children) {
      if (nested.tagName === 'UL' || nested.tagName === 'OL') {
        await docxList(nested, wctx, out, mod, depth + 1);
      }
    }
  }
}

// Runs for an <li>, excluding its nested lists (they become their own
// paragraphs). Nested block children like <p> flatten into the same runs.
async function docxRunsForListItem(li, base, out = []) {
  for (const node of li.childNodes) {
    if (node.nodeType === Node.ELEMENT_NODE && (node.tagName === 'UL' || node.tagName === 'OL')) continue;
    if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'P') {
      await docxRuns(node, base, out);
      continue;
    }
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent.replace(/\s+/g, ' ');
      if (text.trim()) out.push(docxTextRun(text, runStyle(li, base)));
      continue;
    }
    if (node.nodeType === Node.ELEMENT_NODE) {
      await docxRuns({ childNodes: [node] }, base, out);
    }
  }
  return out;
}

async function docxTable(tableEl, wctx) {
  const base = wctx.base;
  const domRows = [...tableEl.querySelectorAll('tr')];
  const colWidths = domRows.length
    ? [...domRows[0].children].map((c) => Math.round(c.getBoundingClientRect().width * PX2TWIP))
    : [];
  const rows = [];
  for (const tr of domRows) {
    const cells = [];
    for (const td of tr.children) {
      const cs = getComputedStyle(td);
      const runs = await docxRuns(td, base, []);
      cells.push(new TableCell({
        width: { size: Math.round(td.getBoundingClientRect().width * PX2TWIP), type: WidthType.DXA },
        shading: hexColor(cs.backgroundColor, base) ? { fill: hexColor(cs.backgroundColor, base) } : undefined,
        margins: { top: 90, bottom: 90, left: 195, right: 195 },
        borders: {
          top: docxBorder(cs, 'Top', base) || { style: BorderStyle.NONE },
          bottom: docxBorder(cs, 'Bottom', base) || { style: BorderStyle.NONE },
          left: docxBorder(cs, 'Left', base) || { style: BorderStyle.NONE },
          right: docxBorder(cs, 'Right', base) || { style: BorderStyle.NONE },
        },
        children: [new Paragraph({
          alignment: ALIGN_DOCX[cs.textAlign] || undefined,
          spacing: { before: 0, after: 0 },
          children: runs.length ? runs : [new TextRun({ text: '' })],
        })],
      }));
    }
    if (cells.length) rows.push(new TableRow({ children: cells }));
  }
  return new Table({
    rows,
    columnWidths: colWidths,
    width: { size: colWidths.reduce((a, b) => a + b, 0), type: WidthType.DXA },
  });
}

export async function buildDocx(ctx) {
  const PAGE = ctx.paperSizes[ctx.app.paperSize] || ctx.paperSizes.A4;
  const contentWidth = PAGE.width - 2 * PAGE.margin;

  const scratch = document.createElement('div');
  scratch.className = 'markdown-body';
  scratch.style.cssText = `position:absolute;left:-99999px;top:0;width:${contentWidth}px;`;
  document.body.appendChild(scratch);
  try {
    await ctx.render(scratch, ctx.getContent(), { theme: 'light' });
    await waitForImages(scratch);

    const wctx = {
      base: { r: 255, g: 255, b: 255 },
      academic: ctx.app.previewStyle === 'academic',
      sec: 0, subsec: 0,
      numberingConfigs: [],
    };
    const children = await docxBlocks(scratch, wctx);

    const pageSize = DOCX_PAGES[ctx.app.paperSize] || DOCX_PAGES.A4;
    const doc = new Document({
      creator: 'Legilo',
      title: ctx.docTitle(),
      numbering: { config: wctx.numberingConfigs },
      sections: [{
        properties: {
          page: {
            size: pageSize,
            margin: {
              top: PAGE.margin * PX2TWIP, bottom: PAGE.margin * PX2TWIP,
              left: PAGE.margin * PX2TWIP, right: PAGE.margin * PX2TWIP,
            },
          },
        },
        children,
      }],
    });
    const blob = await Packer.toBlob(doc);
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    scratch.remove();
  }
}

// ---------------------------------------------------------------------------
// PPTX export — one 16:9 slide per `---` section, blocks at measured positions
// ---------------------------------------------------------------------------

const SLIDE_W_IN = 10;       // 960px design width ↔ 10in ⇒ exactly 96 px/in
const SLIDE_H_IN = 5.625;

function pptxRunOptions(s, extra = {}) {
  return {
    fontFace: s.font,
    fontSize: Math.round(s.sizePx * PX2PT * 10) / 10,
    bold: s.bold,
    italic: s.italic,
    strike: s.strike ? 'sngStrike' : undefined,
    underline: s.underline ? { style: 'sng' } : undefined,
    color: s.color,
    highlight: s.bg || undefined,
    superscript: s.sup || undefined,
    subscript: s.sub || undefined,
    ...extra,
  };
}

// Inline content of `el` → pptxgenjs run objects. Inline images and display
// math can't live inside a pptx text run; they're collected into `sideImages`
// and placed at their measured rects afterwards.
function pptxRuns(el, base, out, sideImages, para = {}) {
  let first = true;
  const push = (text, style, extra = {}) => {
    const options = pptxRunOptions(style, extra);
    if (first) { Object.assign(options, para); first = false; }
    out.push({ text, options });
  };
  (function walk(node, parentEl, link) {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        const text = child.textContent.replace(/\s+/g, ' ');
        if (text) {
          const s = runStyle(parentEl, base);
          push(applyTransform(text, s.transform), s, link ? { hyperlink: { url: link } } : {});
        }
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      if (child.tagName === 'BR') { push('', runStyle(parentEl, base), { breakLine: true }); continue; }
      if (child.tagName === 'INPUT') {
        push(child.checked ? '☑ ' : '☐ ', runStyle(parentEl, base));
        continue;
      }
      if (child.tagName === 'IMG') { sideImages.push({ kind: 'img', el: child }); continue; }
      if (child.classList.contains('katex-mathml')) continue;
      if (child.classList.contains('katex-display')) { sideImages.push({ kind: 'katex', el: child }); continue; }
      if (child.classList.contains('katex')) {
        push(katexTex(child), { ...runStyle(parentEl, base), italic: true });
        continue;
      }
      const childLink = child.tagName === 'A' && /^https?:/i.test(child.href) ? child.href : link;
      walk(child, child, childLink);
    }
  })(el, el, null);
  return out;
}

// Rect of `el` in slide inches, relative to the card.
function slideRect(el, cardRect) {
  const r = el.getBoundingClientRect();
  return {
    x: (r.left - cardRect.left) * PX2IN,
    y: (r.top - cardRect.top) * PX2IN,
    w: r.width * PX2IN,
    h: r.height * PX2IN,
  };
}

function contentBoxOffsets(cs) {
  return {
    left: (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.paddingLeft) || 0),
    right: (parseFloat(cs.borderRightWidth) || 0) + (parseFloat(cs.paddingRight) || 0),
    top: (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.paddingTop) || 0),
    bottom: (parseFloat(cs.borderBottomWidth) || 0) + (parseFloat(cs.paddingBottom) || 0),
  };
}

const PPTX_ALIGN = { center: 'center', right: 'right', justify: 'justify', left: 'left' };

// Background fill, border-accent rects (Slate's h2 bar, heading underlines) —
// drawn as shapes behind/around the text box.
function addBlockDecor(slide, el, rect, cs, base) {
  const bg = hexColor(cs.backgroundColor, base);
  if (bg) {
    const radius = parseFloat(cs.borderRadius) || 0;
    slide.addShape(radius > 0 ? 'roundRect' : 'rect', {
      x: rect.x, y: rect.y, w: rect.w, h: rect.h,
      fill: { color: bg }, line: { type: 'none' },
      rectRadius: radius ? Math.min(radius * PX2IN, rect.h / 4) : undefined,
    });
  }
  const borders = [
    ['Left', { x: rect.x, y: rect.y, h: rect.h }],
    ['Bottom', { x: rect.x, y: rect.y + rect.h, w: rect.w }],
  ];
  for (const [side, pos] of borders) {
    const width = parseFloat(cs[`border${side}Width`]) || 0;
    if (!width || cs[`border${side}Style`] === 'none') continue;
    const color = hexColor(cs[`border${side}Color`], base);
    if (!color) continue;
    slide.addShape('rect', {
      x: pos.x, y: side === 'Bottom' ? pos.y - width * PX2IN : pos.y,
      w: pos.w ?? width * PX2IN, h: pos.h ?? width * PX2IN,
      fill: { color }, line: { type: 'none' },
    });
  }
}

async function addSideImages(slide, sideImages, cardRect) {
  for (const item of sideImages) {
    const rect = slideRect(item.el, cardRect);
    try {
      const pic = item.kind === 'img' ? await imgToOffice(item.el) : await katexToPng(item.el);
      if (pic) slide.addImage({ data: pic.dataUrl, x: rect.x, y: rect.y, w: rect.w, h: rect.h });
    } catch (_) { /* leave the space the DOM reserved for it */ }
  }
}

function textBoxOpts(el, rect, cs, extra = {}) {
  const off = contentBoxOffsets(cs);
  const fs = parseFloat(cs.fontSize) || 24;
  const lh = parseFloat(cs.lineHeight);
  return {
    x: rect.x + off.left * PX2IN,
    y: rect.y + off.top * PX2IN,
    w: rect.w - (off.left + off.right) * PX2IN + 0.05,
    h: rect.h - (off.top + off.bottom) * PX2IN + 0.05,
    align: PPTX_ALIGN[cs.textAlign] || 'left',
    valign: 'top',
    margin: 0,
    fit: 'shrink',
    lineSpacingMultiple: Number.isFinite(lh) ? Math.round((lh / fs) * 100) / 100 : undefined,
    ...extra,
  };
}

async function pptxBlock(slide, el, cardRect, wctx) {
  const tag = el.tagName;
  const cls = el.classList;
  const cs = getComputedStyle(el);
  const base = wctx.base;
  const rect = slideRect(el, cardRect);
  if (rect.h <= 0 || cs.display === 'none') return;

  if (cls.contains('page-break')) return; // hidden on slides

  if (cls.contains('diagram')) {
    const svg = el.querySelector('svg');
    if (svg) {
      const pic = await svgToPng(svg);
      const r = slideRect(svg, cardRect);
      slide.addImage({ data: pic.dataUrl, x: r.x, y: r.y, w: r.w, h: r.h });
    } else {
      slide.addText(el.textContent.trim(), textBoxOpts(el, rect, cs, {
        fontFace: 'Consolas', fontSize: 10, color: 'D1242F',
      }));
    }
    return;
  }

  if (cls.contains('video-embed') || tag === 'VIDEO') {
    const href = videoHref(el);
    // YouTube → a native PowerPoint online-video object (nocookie embeds are
    // rewritten: PowerPoint only recognizes the youtube.com domain).
    if (/youtube(-nocookie)?\.com\/embed\//i.test(href)) {
      slide.addMedia({
        type: 'online', link: href.replace('youtube-nocookie.com', 'youtube.com'),
        x: rect.x, y: rect.y, w: rect.w, h: rect.h,
      });
      return;
    }
    // Local video file → embed the bytes as playable media. PowerPoint plays
    // mp4/m4v/mov natively; webm and friends fall through to the link box.
    const videoEl = tag === 'VIDEO' ? el : el.querySelector('video');
    const src = videoEl?.currentSrc || videoEl?.src || '';
    if (src.startsWith('file:') && /\.(mp4|m4v|mov)$/i.test(src)) {
      const dataUrl = await window.legilo.readFileBinary(fileUrlToPath(src));
      if (dataUrl?.startsWith('data:video/')) {
        slide.addMedia({
          type: 'video', data: dataUrl.slice(5), // "video/mp4;base64,…"
          x: rect.x, y: rect.y, w: rect.w, h: rect.h,
        });
        return;
      }
    }
    // Fallback (Vimeo, webm, unreadable file): a linked placeholder box.
    slide.addShape('roundRect', {
      x: rect.x, y: rect.y, w: rect.w, h: rect.h,
      fill: { color: '000000' }, line: { type: 'none' }, rectRadius: 0.06,
    });
    slide.addText(`▶ ${href || 'video'}`, {
      x: rect.x, y: rect.y, w: rect.w, h: rect.h,
      align: 'center', valign: 'middle', color: 'FFFFFF', fontSize: 12,
      hyperlink: /^https?:/i.test(href) ? { url: href } : undefined,
    });
    return;
  }

  switch (tag) {
    case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6': {
      addBlockDecor(slide, el, rect, cs, base);
      const runs = [];
      const prefix = headingPrefix(el, wctx);
      if (prefix) {
        const s = runStyle(el, base);
        runs.push({ text: applyTransform(prefix, s.transform), options: pptxRunOptions(s) });
      }
      pptxRuns(el, base, runs, wctx.sideImages);
      if (runs.length) slide.addText(runs, textBoxOpts(el, rect, cs));
      return;
    }
    case 'P': {
      // paragraph that is just an image / display math → place as image only
      const only = el.children.length === 1 && !el.textContent.trim() ? el.children[0] : null;
      if (only && only.tagName === 'IMG') { wctx.sideImages.push({ kind: 'img', el: only }); return; }
      addBlockDecor(slide, el, rect, cs, base);
      const runs = pptxRuns(el, base, [], wctx.sideImages);
      if (runs.length) slide.addText(runs, textBoxOpts(el, rect, cs));
      return;
    }
    case 'UL': case 'OL': {
      const runs = [];
      pptxList(el, base, runs, wctx.sideImages, 0);
      if (runs.length) {
        runs[runs.length - 1].options.breakLine = false;
        slide.addText(runs, textBoxOpts(el, rect, cs, { x: rect.x, w: rect.w + 0.05 }));
      }
      return;
    }
    case 'BLOCKQUOTE': {
      addBlockDecor(slide, el, rect, cs, base);
      const runs = [];
      for (const child of el.children) {
        pptxRuns(child, base, runs, wctx.sideImages);
        if (runs.length) runs[runs.length - 1].options.breakLine = true;
      }
      if (runs.length) {
        runs[runs.length - 1].options.breakLine = false;
        slide.addText(runs, textBoxOpts(el, rect, cs));
      }
      return;
    }
    case 'PRE': {
      addBlockDecor(slide, el, rect, cs, base);
      const lines = segmentsToLines(textSegments(el.querySelector('code') || el, base));
      const runs = [];
      lines.forEach((line, i) => {
        if (line.length === 0) runs.push({ text: '', options: { breakLine: true } });
        line.forEach((seg, j) => runs.push({
          text: seg.text,
          options: pptxRunOptions(seg.style, { breakLine: j === line.length - 1 }),
        }));
      });
      if (runs.length) {
        runs[runs.length - 1].options.breakLine = false;
        slide.addText(runs, textBoxOpts(el, rect, cs));
      }
      return;
    }
    case 'TABLE': {
      pptxTable(slide, el, cardRect, base);
      return;
    }
    case 'HR': {
      slide.addShape('rect', {
        x: rect.x, y: rect.y, w: rect.w, h: Math.max(rect.h, 0.02),
        fill: { color: hexColor(cs.backgroundColor, base) || 'D1D9E0' }, line: { type: 'none' },
      });
      return;
    }
    case 'SECTION': case 'DIV': {
      for (const child of el.children) await pptxBlock(slide, child, cardRect, wctx);
      return;
    }
    default: {
      const runs = pptxRuns(el, base, [], wctx.sideImages);
      if (runs.length) slide.addText(runs, textBoxOpts(el, rect, cs));
    }
  }
}

function pptxList(listEl, base, runs, sideImages, depth) {
  const ordered = listEl.tagName === 'OL';
  const start = parseInt(listEl.getAttribute('start') || '1', 10);
  let index = 0;
  for (const li of listEl.children) {
    if (li.tagName !== 'LI') continue;
    const isTask = li.classList.contains('task-list-item');
    const bullet = isTask ? false
      : ordered ? { type: 'number', startAt: index === 0 ? start : undefined, indent: 18 }
        : { code: '2022', indent: 18 };
    // Paragraph props go on every run of the item: pptxgenjs reads them from
    // the run that terminates the paragraph, whichever run that ends up being.
    const para = { bullet, indentLevel: depth, paraSpaceAfter: 2 };
    const before = runs.length;
    (function inlineOnly(node, parentEl, link) {
      for (const child of node.childNodes) {
        if (child.nodeType === Node.ELEMENT_NODE && (child.tagName === 'UL' || child.tagName === 'OL')) continue;
        if (child.nodeType === Node.TEXT_NODE) {
          const text = child.textContent.replace(/\s+/g, ' ');
          if (text) {
            const s = runStyle(parentEl, base);
            runs.push({
              text: applyTransform(text, s.transform),
              options: { ...pptxRunOptions(s, link ? { hyperlink: { url: link } } : {}), ...para },
            });
          }
          continue;
        }
        if (child.nodeType !== Node.ELEMENT_NODE) continue;
        if (child.tagName === 'INPUT') {
          runs.push({
            text: child.checked ? '☑ ' : '☐ ',
            options: { ...pptxRunOptions(runStyle(parentEl, base)), ...para },
          });
          continue;
        }
        if (child.tagName === 'IMG') { sideImages.push({ kind: 'img', el: child }); continue; }
        if (child.classList.contains('katex-mathml')) continue;
        if (child.classList.contains('katex')) {
          runs.push({
            text: katexTex(child),
            options: { ...pptxRunOptions({ ...runStyle(parentEl, base), italic: true }), ...para },
          });
          continue;
        }
        const childLink = child.tagName === 'A' && /^https?:/i.test(child.href) ? child.href : link;
        inlineOnly(child, child, childLink);
      }
    })(li, li, null);
    if (runs.length > before) runs[runs.length - 1].options.breakLine = true;
    index += 1;
    for (const nested of li.children) {
      if (nested.tagName === 'UL' || nested.tagName === 'OL') {
        pptxList(nested, base, runs, sideImages, depth + 1);
      }
    }
  }
}

function pptxTable(slide, tableEl, cardRect, base) {
  const domRows = [...tableEl.querySelectorAll('tr')];
  if (!domRows.length) return;
  const rect = slideRect(tableEl, cardRect);
  const colW = [...domRows[0].children].map((c) => c.getBoundingClientRect().width * PX2IN);
  const rows = domRows.map((tr) => [...tr.children].map((td) => {
    const cs = getComputedStyle(td);
    const s = runStyle(td, base);
    const mkBorder = (side) => {
      const w = parseFloat(cs[`border${side}Width`]) || 0;
      const c = hexColor(cs[`border${side}Color`], base);
      return w && c && cs[`border${side}Style`] !== 'none'
        ? { type: 'solid', pt: Math.max(0.5, w * PX2PT), color: c }
        : { type: 'none' };
    };
    const cellRuns = pptxRuns(td, base, [], []);
    return {
      text: cellRuns.length ? cellRuns : td.textContent.replace(/\s+/g, ' ').trim(),
      options: {
        fontFace: s.font, fontSize: Math.round(s.sizePx * PX2PT * 10) / 10,
        bold: s.bold, italic: s.italic, color: s.color,
        fill: hexColor(cs.backgroundColor, base) ? { color: hexColor(cs.backgroundColor, base) } : undefined,
        align: PPTX_ALIGN[cs.textAlign] || 'left',
        valign: 'middle',
        border: [mkBorder('Top'), mkBorder('Right'), mkBorder('Bottom'), mkBorder('Left')],
        margin: [4.5, 9.75, 4.5, 9.75], // th/td padding 6px 13px in points
      },
    };
  }));
  slide.addTable(rows, { x: rect.x, y: rect.y, colW, autoPage: false });
}

export async function buildPptx(ctx) {
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'LEGILO_16x9', width: SLIDE_W_IN, height: SLIDE_H_IN });
  pptx.layout = 'LEGILO_16x9';
  pptx.author = 'Legilo';
  pptx.title = ctx.docTitle();

  const parts = ctx.splitSlides(ctx.getContent());
  for (const part of parts) {
    // Build the slide exactly like the slides preview: same card, same
    // auto-shrink — so the export mirrors what Legilo shows on screen.
    const card = document.createElement('div');
    card.className = 'slide-card';
    card.style.cssText = 'position:absolute;left:-99999px;top:0;margin:0;';
    const body = document.createElement('div');
    body.className = 'slide-card-content markdown-body';
    card.appendChild(body);
    document.body.appendChild(card);
    try {
      await ctx.render(body, part.text, { theme: ctx.app.theme });
      await waitForImages(body);
      ctx.fitContent(body, card.clientHeight - 96, ctx.slideBaseFont);

      const cardCs = getComputedStyle(card);
      const cardBase = parseColor(cardCs.backgroundColor) || { r: 255, g: 255, b: 255 };
      const slide = pptx.addSlide();
      slide.background = { color: hexColor(cardCs.backgroundColor) || 'FFFFFF' };

      const cardRect = card.getBoundingClientRect();
      const wctx = {
        base: cardBase,
        academic: ctx.app.previewStyle === 'academic',
        sec: 0, subsec: 0,
        sideImages: [],
      };
      for (const el of body.children) {
        await pptxBlock(slide, el, cardRect, wctx);
      }
      await addSideImages(slide, wctx.sideImages, cardRect);
    } finally {
      card.remove();
    }
  }

  const buf = await pptx.write({ outputType: 'arraybuffer' });
  return new Uint8Array(buf);
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

export async function exportOfficeDocx(ctx) {
  // Word documents are always light-theme, like HTML/PDF export and print.
  const wasDark = document.body.classList.contains('theme-dark');
  if (wasDark) document.body.classList.replace('theme-dark', 'theme-light');
  try {
    const data = await buildDocx(ctx);
    return await window.legilo.exportOffice(data, `${ctx.docTitle()}.docx`, 'docx');
  } catch (err) {
    alert(`Word export failed: ${err?.message || err}`);
    return null;
  } finally {
    if (wasDark) document.body.classList.replace('theme-light', 'theme-dark');
  }
}

export async function exportOfficePptx(ctx) {
  // Slides follow the current theme, mirroring the presenter view.
  try {
    const data = await buildPptx(ctx);
    return await window.legilo.exportOffice(data, `${ctx.docTitle()}.pptx`, 'pptx');
  } catch (err) {
    alert(`PowerPoint export failed: ${err?.message || err}`);
    return null;
  }
}
