import { EditorState, Compartment } from '@codemirror/state';
import {
  EditorView, keymap, lineNumbers, highlightActiveLine,
  highlightActiveLineGutter, drawSelection, dropCursor,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { search, searchKeymap, openSearchPanel, highlightSelectionMatches } from '@codemirror/search';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching } from '@codemirror/language';
import { oneDark } from '@codemirror/theme-one-dark';

import MarkdownIt from 'markdown-it';
import markdownItFootnote from 'markdown-it-footnote';
import markdownItTaskLists from 'markdown-it-task-lists';
import markdownItKatex from '@vscode/markdown-it-katex';
import hljs from 'highlight.js/lib/common';
import TurndownService from 'turndown';
import { gfm as turndownGfm } from 'turndown-plugin-gfm';
import mermaid from 'mermaid';
import { D2 } from '@terrastruct/d2';
import { exportOfficeDocx, exportOfficePptx } from './export-office.js';

// ---------------------------------------------------------------------------
// Markdown renderer
// ---------------------------------------------------------------------------

const md = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
  highlight(code, lang) {
    const l = (lang || '').trim().toLowerCase();
    if (l === 'mermaid' || l === 'd2') {
      // Placeholder; hydrateDiagrams() swaps it for the rendered SVG.
      return `<pre class="diagram" data-lang="${l}">${md.utils.escapeHtml(code)}</pre>`;
    }
    if (lang && hljs.getLanguage(lang)) {
      try {
        return `<pre class="hljs"><code>${hljs.highlight(code, { language: lang, ignoreIllegals: true }).value}</code></pre>`;
      } catch (_) { /* fall through */ }
    }
    return `<pre class="hljs"><code>${md.utils.escapeHtml(code)}</code></pre>`;
  },
})
  .use(markdownItFootnote)
  .use(markdownItTaskLists, { enabled: true, label: true })
  .use(markdownItKatex.default ?? markdownItKatex, { throwOnError: false });

// markdown-it rejects file: URLs by default; this is a local desktop app
// where linking local images/files is the point.
const validateLinkDefault = md.validateLink.bind(md);
md.validateLink = (url) => validateLinkDefault(url) || /^file:/i.test(url);

// `\pagebreak` (or `\newpage`) on a line of its own becomes a page break:
// a dashed marker in the preview, a real break in page view, print and PDF.
md.block.ruler.before('paragraph', 'pagebreak', (state, startLine, _endLine, silent) => {
  const pos = state.bMarks[startLine] + state.tShift[startLine];
  const line = state.src.slice(pos, state.eMarks[startLine]).trim();
  if (line !== '\\pagebreak' && line !== '\\newpage') return false;
  if (silent) return true;
  state.line = startLine + 1;
  const token = state.push('pagebreak', 'div', 0);
  token.markup = line;
  token.map = [startLine, state.line];
  return true;
});
md.renderer.rules.pagebreak = () => '<div class="page-break" aria-label="page break"></div>\n';

// ---------------------------------------------------------------------------
// Diagrams — ```mermaid and ```d2 fences render to inline SVG
// ---------------------------------------------------------------------------

mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });

let d2 = null;          // D2 spins up a WASM worker; create it only when needed
let diagramSeq = 0;
// key: lang\0theme\0source → { svg } | { error } | { promise } while rendering
const diagramCache = new Map();

// Renders are serialized: mermaid's theme is global config, so two renders
// with different themes (preview vs. export) must not interleave.
let diagramQueue = Promise.resolve();

const D2_DARK_THEME = 200; // "Dark Mauve"

async function renderDiagramSvg(lang, code, theme) {
  if (lang === 'mermaid') {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: theme === 'dark' ? 'dark' : 'default',
    });
    const id = `legilo-mmd-${++diagramSeq}`;
    try {
      const { svg } = await mermaid.render(id, code);
      return svg;
    } finally {
      // mermaid can leave scratch/error nodes in the body on failure
      document.getElementById(id)?.remove();
      document.getElementById('d' + id)?.remove();
    }
  }
  if (!d2) d2 = new D2();
  const compiled = await d2.compile(code);
  return d2.render(compiled.diagram, {
    themeID: theme === 'dark' ? D2_DARK_THEME : 0,
    pad: 16,
    scale: 1, // natural size with explicit width/height; CSS caps the maximum
    noXMLTag: true,
  });
}

function startDiagramRender(lang, code, theme, key) {
  if (diagramCache.size > 300) diagramCache.clear(); // editing churns keys
  const entry = {};
  const job = () => renderDiagramSvg(lang, code, theme)
    .then((svg) => { entry.svg = svg; })
    .catch((err) => { entry.error = String(err?.message || err).trim(); });
  entry.promise = diagramQueue.then(job, job);
  diagramQueue = entry.promise;
  diagramCache.set(key, entry);
  return entry;
}

function substituteDiagram(block, entry, lang, code) {
  const box = document.createElement('div');
  if (entry.svg != null) {
    box.className = `diagram diagram-${lang}`;
    box.innerHTML = entry.svg; // generated locally by mermaid/d2, not user HTML
  } else {
    box.className = 'diagram diagram-error';
    const msg = document.createElement('div');
    msg.className = 'diagram-error-msg';
    msg.textContent = `${lang} diagram error: ${entry.error}`;
    const pre = document.createElement('pre');
    pre.textContent = code;
    box.append(msg, pre);
  }
  block.replaceWith(box);
}

// Swaps every `pre.diagram` placeholder in `el` for its rendered SVG.
// Cached diagrams are substituted synchronously; misses render async and are
// patched in place when they land (then `onUpdate` fires so layout-sensitive
// views — page/slides — can re-measure). Resolves when everything settled.
function hydrateDiagrams(el, theme, onUpdate) {
  const pending = [];
  for (const block of el.querySelectorAll('pre.diagram')) {
    const lang = block.dataset.lang;
    const code = block.textContent;
    const key = `${lang}\0${theme}\0${code}`;
    let entry = diagramCache.get(key);
    if (entry && !entry.promise) {
      substituteDiagram(block, entry, lang, code);
      continue;
    }
    if (!entry) entry = startDiagramRender(lang, code, theme, key);
    block.classList.add('diagram-loading');
    pending.push(entry.promise.then(() => {
      delete entry.promise;
      if (!block.isConnected) return; // view re-rendered meanwhile
      substituteDiagram(block, entry, lang, code);
      onUpdate?.();
    }));
  }
  return Promise.all(pending).then(() => {});
}

// ---------------------------------------------------------------------------
// DOM handles & app state
// ---------------------------------------------------------------------------

const previewEl = document.getElementById('preview');
const previewPane = document.getElementById('preview-pane');
const editorPane = document.getElementById('editor-pane');
const divider = document.getElementById('divider');
const tabsEl = document.getElementById('tabs');
const btnTabAdd = document.getElementById('tab-add');
const btnView = document.getElementById('btn-view');
const btnTheme = document.getElementById('btn-theme');
const btnPresent = document.getElementById('btn-present');
const presenterEl = document.getElementById('presenter');
const slideEl = document.getElementById('slide');
const slideStage = document.getElementById('slide-stage');
const slideCounter = document.getElementById('slide-counter');

const app = {
  theme: 'light',
  viewMode: 'split',      // 'split' | 'editor' | 'preview'
  previewMode: 'flow',    // 'flow' | 'page' (Word-like sheets) | 'slides'
  paperSize: 'A4',        // 'A4' | 'Letter'
  previewStyle: 'github', // 'github' | 'book' | 'minimal'
};

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

let nextTabId = 1;
const tabs = []; // { id, filePath, state: EditorState, dirty, previewScroll }
let activeTab = null;

function tabName(tab) {
  if (tab.label) return tab.label;
  if (!tab.filePath) return 'Untitled';
  return tab.filePath.split(/[\\/]/).pop();
}

function updateTitle() {
  if (!activeTab) return;
  window.legilo.setTitle(`${tabName(activeTab)}${activeTab.dirty ? ' *' : ''} — Legilo`);
}

function renderTabBar() {
  tabsEl.innerHTML = '';
  for (const tab of tabs) {
    const el = document.createElement('div');
    el.className = 'tab' + (tab === activeTab ? ' active' : '');
    el.title = tab.filePath || 'Untitled';

    const name = document.createElement('span');
    name.className = 'tab-name';
    name.textContent = (tab.dirty ? '• ' : '') + tabName(tab);
    el.appendChild(name);

    const close = document.createElement('button');
    close.className = 'tab-close';
    close.textContent = '×';
    close.title = 'Close tab (Ctrl+W)';
    close.addEventListener('click', (e) => { e.stopPropagation(); closeTab(tab); });
    el.appendChild(close);

    el.addEventListener('click', () => activateTab(tab));
    el.addEventListener('auxclick', (e) => { if (e.button === 1) closeTab(tab); });
    tabsEl.appendChild(el);
  }
}

function markDirty() {
  if (!activeTab || activeTab.dirty) return;
  activeTab.dirty = true;
  renderTabBar();
  updateTitle();
}

function clearDirty() {
  if (!activeTab) return;
  activeTab.dirty = false;
  renderTabBar();
  updateTitle();
}

function newTab({ filePath = null, content = '', label = null } = {}) {
  const tab = {
    id: nextTabId++,
    filePath,
    label,
    state: createEditorState(content),
    dirty: false,
    previewScroll: 0,
  };
  tabs.push(tab);
  activateTab(tab);
  return tab;
}

function activateTab(tab) {
  // The live document for the active tab is in editorView, not tab.state —
  // re-activating it must not overwrite the editor with a stale snapshot.
  if (activeTab === tab) {
    renderTabBar();
    updateTitle();
    return;
  }
  if (activeTab) {
    activeTab.state = editorView.state;
    activeTab.previewScroll = previewPane.scrollTop;
  }
  activeTab = tab;
  editorView.setState(tab.state);
  // setState wipes compartment reconfigurations applied to the old state
  editorView.dispatch({ effects: themeCompartment.reconfigure(editorThemeExt()) });
  renderPreview();
  previewPane.scrollTop = tab.previewScroll || 0;
  renderTabBar();
  updateTitle();
  saveSession();
  editorView.focus();
}

// Returns false when the user cancelled (tab stays open).
async function closeTab(tab) {
  if (tab.dirty) {
    activateTab(tab); // make sure the user sees what they're deciding about
    const choice = await window.legilo.confirmUnsaved(tabName(tab));
    if (choice === 'cancel') return false;
    if (choice === 'save' && !(await saveDocument())) return false;
  }
  const idx = tabs.indexOf(tab);
  tabs.splice(idx, 1);
  if (tabs.length === 0) {
    newTab(); // always keep one tab
  } else if (tab === activeTab) {
    activateTab(tabs[Math.min(idx, tabs.length - 1)]);
  } else {
    renderTabBar();
    saveSession();
  }
  return true;
}

function cycleTab(dir) {
  if (tabs.length < 2) return;
  const idx = tabs.indexOf(activeTab);
  activateTab(tabs[(idx + dir + tabs.length) % tabs.length]);
}

function saveSession() {
  window.legilo.setSession({
    files: tabs.filter((t) => t.filePath).map((t) => t.filePath),
    active: activeTab?.filePath || null,
  });
}

// ---------------------------------------------------------------------------
// CodeMirror editor
// ---------------------------------------------------------------------------

const themeCompartment = new Compartment();

const lightEditorTheme = [
  syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
  EditorView.theme({}, { dark: false }),
];

function editorThemeExt() {
  return app.theme === 'dark' ? oneDark : lightEditorTheme;
}

let renderTimer = null;

function createEditorState(content) {
  return EditorState.create({
    doc: content,
    extensions: [
      lineNumbers(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      drawSelection(),
      dropCursor(),
      history(),
      bracketMatching(),
      search({ top: true }),
      highlightSelectionMatches(),
      keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
      markdown({ base: markdownLanguage, codeLanguages: languages }),
      EditorView.lineWrapping,
      themeCompartment.of(editorThemeExt()),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          markDirty();
          clearTimeout(renderTimer);
          renderTimer = setTimeout(renderPreview, 120);
        }
      }),
    ],
  });
}

const editorView = new EditorView({
  state: EditorState.create({ doc: '' }),
  parent: editorPane,
});

function getContent() {
  return editorView.state.doc.toString();
}

function activeDocDir() {
  return activeTab?.filePath
    ? activeTab.filePath.replaceAll('\\', '/').split('/').slice(0, -1).join('/')
    : null;
}

function resolveLocalPath(src, docDir) {
  if (docDir && src && !/^[a-z][a-z0-9+.-]*:|^\//i.test(src)) {
    return 'file:///' + encodeURI(`${docDir}/${src}`.replace(/^\//, ''));
  }
  return null;
}

// ---- video embeds: a bare video URL on a line of its own becomes a player ----

function videoEmbedUrl(href) {
  let m = href.match(/^https?:\/\/(?:www\.|m\.)?(?:youtube(?:-nocookie)?\.com\/(?:watch\?[^#]*v=|shorts\/|embed\/)|youtu\.be\/)([\w-]{6,20})/i);
  if (m) {
    const t = href.match(/[?&](?:t|start)=(\d+)/);
    return `https://www.youtube-nocookie.com/embed/${m[1]}${t ? `?start=${t[1]}` : ''}`;
  }
  m = href.match(/^https?:\/\/(?:www\.)?vimeo\.com\/(\d+)/i);
  if (m) return `https://player.vimeo.com/video/${m[1]}`;
  return null;
}

// A paragraph that is nothing but a bare link (linkify keeps text === URL)
// becomes an embed; a labeled link like [demo](url) stays a normal link.
function embedVideos(el, docDir) {
  for (const a of el.querySelectorAll('p > a')) {
    const p = a.parentElement;
    if (p.children.length !== 1 || p.textContent.trim() !== a.textContent.trim()) continue;
    const href = a.getAttribute('href') || '';
    if (a.textContent.trim() !== href.trim()) continue;

    const embed = videoEmbedUrl(href);
    if (embed) {
      const box = document.createElement('div');
      box.className = 'video-embed';
      const frame = document.createElement('iframe');
      frame.src = embed;
      frame.allow = 'autoplay; encrypted-media; fullscreen; picture-in-picture';
      box.appendChild(frame);
      p.replaceWith(box);
    } else if (/\.(mp4|webm|ogg|m4v|mov)$/i.test(href)) {
      const video = document.createElement('video');
      video.className = 'video-embed';
      video.controls = true;
      video.src = resolveLocalPath(href, docDir) || href;
      p.replaceWith(video);
    }
  }
}

function renderMarkdownInto(el, src, { theme = null, onUpdate = null } = {}) {
  el.innerHTML = md.render(src);
  // Resolve relative image paths against the document's folder so local
  // images (inserted via Insert → Image…) show up in the preview.
  const docDir = activeDocDir();
  for (const img of el.querySelectorAll('img')) {
    const resolved = resolveLocalPath(img.getAttribute('src') || '', docDir);
    if (resolved) img.src = resolved;
  }
  embedVideos(el, docDir);
  return hydrateDiagrams(el, theme || app.theme, onUpdate);
}

// Page and slides layouts measure block heights, so they re-render (debounced)
// when an async diagram lands; the flow view is patched in place and needs
// nothing further.
function schedulePreviewUpdate() {
  if (app.previewMode === 'flow') return;
  clearTimeout(renderTimer);
  renderTimer = setTimeout(renderPreview, 120);
}

function renderPreview() {
  if (app.previewMode === 'page') renderPaged();
  else if (app.previewMode === 'slides') renderSlidesPreview();
  else renderMarkdownInto(previewEl, getContent());
}

// ---- Word-like page view: distribute rendered blocks over paper sheets ----

// Pixel sizes at 96 dpi, with ~20 mm margins.
const PAPER_SIZES = {
  A4: { width: 794, height: 1123, margin: 76 },      // 210 × 297 mm
  Letter: { width: 816, height: 1056, margin: 76 },  // 8.5 × 11 in
};

function renderPaged() {
  const PAGE = PAPER_SIZES[app.paperSize] || PAPER_SIZES.A4;
  document.documentElement.style.setProperty('--page-w', `${PAGE.width}px`);
  document.documentElement.style.setProperty('--page-h', `${PAGE.height}px`);
  const contentH = PAGE.height - 2 * PAGE.margin;

  // Render at page width in an off-screen box so measurements are correct.
  const scratch = document.createElement('div');
  scratch.className = 'markdown-body';
  scratch.style.cssText =
    `position:absolute;left:-99999px;top:0;width:${PAGE.width - 2 * PAGE.margin}px;`;
  document.body.appendChild(scratch);
  // Diagram nodes move into the pages below, so async diagrams still land
  // in place; onUpdate then re-paginates with the real heights.
  renderMarkdownInto(scratch, getContent(), { onUpdate: schedulePreviewUpdate });

  previewEl.innerHTML = '';
  let pageContent = null;

  const newPage = () => {
    const page = document.createElement('div');
    page.className = 'page';
    pageContent = document.createElement('div');
    pageContent.className = 'page-content markdown-body';
    page.appendChild(pageContent);
    previewEl.appendChild(page);
  };

  newPage();
  for (const node of [...scratch.childNodes]) {
    // Explicit page break: always start a fresh sheet (the marker itself
    // isn't shown). Consecutive breaks therefore produce blank pages.
    if (node.nodeType === 1 && node.classList.contains('page-break')) {
      newPage();
      continue;
    }
    pageContent.appendChild(node);
    // Overflowing block moves to a fresh page — unless it's alone on this
    // page already (a block taller than one page just overflows).
    if (pageContent.getBoundingClientRect().height > contentH &&
        pageContent.children.length > 1) {
      newPage();
      pageContent.appendChild(node);
    }
  }
  scratch.remove();

  // page numbers
  const pages = previewEl.querySelectorAll('.page');
  pages.forEach((p, i) => { p.dataset.pageno = `${i + 1} / ${pages.length}`; });

  // images load async and change block heights — re-paginate when they land
  for (const img of previewEl.querySelectorAll('img')) {
    if (!img.complete) {
      img.addEventListener('load', () => {
        clearTimeout(renderTimer);
        renderTimer = setTimeout(renderPreview, 120);
      }, { once: true });
    }
  }
}

// ---- slides preview: scroll through the presentation in the preview pane ----

// Shrinks the base font until `el` fits in `availH` px. Returns the final
// scale factor (1 = untouched).
function fitContent(el, availH, baseFontPx) {
  el.style.fontSize = '';
  let scale = 1;
  for (let i = 0; i < 4 && el.scrollHeight > availH && scale > 0.4; i++) {
    scale = Math.max(0.4, scale * (availH / el.scrollHeight) * 0.98);
    el.style.fontSize = `${baseFontPx * scale}px`;
  }
  return scale;
}

const SLIDE_BASE_FONT = 24;

function renderSlidesPreview() {
  previewEl.innerHTML = '';
  const parts = splitSlides(getContent());
  parts.forEach((part, i) => {
    const card = document.createElement('div');
    card.className = 'slide-card';
    card.dataset.slideno = `${i + 1} / ${parts.length}`;
    const body = document.createElement('div');
    body.className = 'slide-card-content markdown-body';
    card.appendChild(body);
    previewEl.appendChild(card);
    renderMarkdownInto(body, part.text, { onUpdate: schedulePreviewUpdate });
    const scale = fitContent(body, card.clientHeight - 96, SLIDE_BASE_FONT);
    if (scale < 1) {
      card.classList.add('overfull');
      card.dataset.warn = `text scaled to ${Math.round(scale * 100)}% — consider splitting this slide with ---`;
    }
  });
  scaleSlideCards();
}

// Fit the fixed-size cards to the pane width (zoom affects layout, so the
// scroll height stays correct — fine in Chromium, which is all we run in).
function scaleSlideCards() {
  if (app.previewMode !== 'slides') return;
  const zoom = Math.min(1, (previewPane.clientWidth - 48) / 960);
  for (const card of previewEl.querySelectorAll('.slide-card')) {
    card.style.zoom = zoom;
  }
}

new ResizeObserver(() => scaleSlideCards()).observe(previewPane);

// ---------------------------------------------------------------------------
// Synchronized scrolling (proportional)
// ---------------------------------------------------------------------------

const scroller = editorView.scrollDOM;
let syncSource = null; // which pane initiated the current scroll
let syncResetTimer = null;

function ratioOf(el) {
  const max = el.scrollHeight - el.clientHeight;
  return max > 0 ? el.scrollTop / max : 0;
}

function applyRatio(el, ratio) {
  const max = el.scrollHeight - el.clientHeight;
  el.scrollTop = ratio * max;
}

function onScroll(sourceName, sourceEl, targetEl) {
  if (syncSource && syncSource !== sourceName) return; // ignore echo
  syncSource = sourceName;
  applyRatio(targetEl, ratioOf(sourceEl));
  clearTimeout(syncResetTimer);
  syncResetTimer = setTimeout(() => { syncSource = null; }, 80);
}

scroller.addEventListener('scroll', () => onScroll('editor', scroller, previewPane));
previewPane.addEventListener('scroll', () => onScroll('preview', previewPane, scroller));

// ---------------------------------------------------------------------------
// Theme & view mode
// ---------------------------------------------------------------------------

function applyTheme(theme) {
  app.theme = theme;
  document.body.classList.toggle('theme-dark', theme === 'dark');
  document.body.classList.toggle('theme-light', theme === 'light');
  editorView.dispatch({ effects: themeCompartment.reconfigure(editorThemeExt()) });
  btnTheme.querySelector('.theme-label').textContent = theme === 'dark' ? 'Light' : 'Dark';
  window.legilo.setPref('theme', theme);
  renderPreview(); // diagram SVGs are baked per-theme
}

const VIEW_LABELS = { split: 'Split', editor: 'Editor', preview: 'Preview' };

function applyViewMode(mode) {
  app.viewMode = mode;
  document.body.classList.remove('mode-split', 'mode-editor', 'mode-preview');
  document.body.classList.add(`mode-${mode}`);
  btnView.querySelector('.view-label').textContent = VIEW_LABELS[mode];
  window.legilo.setPref('viewMode', mode);
  editorView.requestMeasure();
}

// ---- preview styles: built-in presets + user-supplied CSS ----

const PREVIEW_STYLES = ['github', 'book', 'minimal', 'academic', 'slate', 'typewriter', 'newspaper'];

function applyPreviewStyle(style) {
  app.previewStyle = style;
  for (const s of PREVIEW_STYLES) {
    document.body.classList.toggle(`style-${s}`, s === style && s !== 'github');
  }
  window.legilo.setPref('previewStyle', style);
  renderPreview();
}

// User CSS is injected in a <style> after the app stylesheet so it wins on
// equal specificity. Target `.markdown-body …` in the file for best results.
function setCustomCss(css) {
  let el = document.getElementById('custom-css');
  if (!el) {
    el = document.createElement('style');
    el.id = 'custom-css';
    document.head.appendChild(el);
  }
  el.textContent = css || '';
  renderPreview();
}

async function loadCustomCss() {
  const css = await window.legilo.pickCustomCss();
  if (css !== null) setCustomCss(css);
}

const PREVIEW_LABELS = { flow: 'Flow', page: 'Page', slides: 'Slides' };

function applyPreviewMode(mode) {
  app.previewMode = mode;
  document.body.classList.toggle('preview-paged', mode === 'page');
  document.body.classList.toggle('preview-slides', mode === 'slides');
  document.getElementById('btn-page').querySelector('.page-label').textContent = PREVIEW_LABELS[mode];
  window.legilo.setPref('previewMode', mode);
  renderPreview();
}

function cyclePreviewMode() {
  const order = ['flow', 'page', 'slides'];
  applyPreviewMode(order[(order.indexOf(app.previewMode) + 1) % order.length]);
}

function applyPaperSize(size) {
  app.paperSize = size;
  window.legilo.setPref('paperSize', size);
  renderPreview();
}

document.getElementById('btn-page').addEventListener('click', cyclePreviewMode);

btnTheme.addEventListener('click', () => applyTheme(app.theme === 'dark' ? 'light' : 'dark'));
btnView.addEventListener('click', () => {
  const order = ['split', 'editor', 'preview'];
  applyViewMode(order[(order.indexOf(app.viewMode) + 1) % order.length]);
});
btnTabAdd.addEventListener('click', () => newTab());
btnPresent.addEventListener('click', enterPresenter);
document.getElementById('btn-insert').addEventListener('click', () => window.legilo.popupInsertMenu());
document.getElementById('btn-help').addEventListener('click', () => showGuide());

// ---------------------------------------------------------------------------
// Draggable divider
// ---------------------------------------------------------------------------

divider.addEventListener('mousedown', (e) => {
  e.preventDefault();
  const workspace = document.getElementById('workspace');
  document.body.classList.add('dragging');

  function onMove(ev) {
    const rect = workspace.getBoundingClientRect();
    let pct = ((ev.clientX - rect.left) / rect.width) * 100;
    pct = Math.min(85, Math.max(15, pct));
    editorPane.style.flex = `0 0 ${pct}%`;
  }
  function onUp() {
    document.body.classList.remove('dragging');
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    editorView.requestMeasure();
  }
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
});

// ---------------------------------------------------------------------------
// Presenter mode — slides split on top-level `---` (like Marp)
// ---------------------------------------------------------------------------

let slides = [];
let slideIndex = 0;
let presenting = false;

// Token-based split so `---` inside code fences (or setext headings) doesn't
// cut a slide.
function splitSlides(src) {
  const cuts = md.parse(src, {})
    .filter((t) => t.type === 'hr' && t.level === 0 && t.map)
    .map((t) => t.map[0]);
  const lines = src.split('\n');
  const parts = [];
  let start = 0;
  for (const cut of cuts) {
    parts.push({ text: lines.slice(start, cut).join('\n'), startLine: start });
    start = cut + 1;
  }
  parts.push({ text: lines.slice(start).join('\n'), startLine: start });
  const nonEmpty = parts.filter((p) => p.text.trim() !== '');
  return nonEmpty.length ? nonEmpty : [{ text: src, startLine: 0 }];
}

function slideForCursor() {
  const line = editorView.state.doc.lineAt(editorView.state.selection.main.head).number - 1;
  let idx = 0;
  slides.forEach((s, i) => { if (s.startLine <= line) idx = i; });
  return idx;
}

function renderSlide() {
  renderMarkdownInto(slideEl, slides[slideIndex].text, {
    onUpdate: () => { if (presenting) renderSlide(); }, // re-fit once diagrams land
  });
  slideCounter.textContent = `${slideIndex + 1} / ${slides.length}`;
  // Shrink overflowing slides so nothing falls off the edge, and tell the
  // presenter about it so they know to split the slide.
  const warn = document.getElementById('slide-warn');
  const scale = fitContent(slideEl, slideStage.clientHeight - 96, SLIDE_BASE_FONT);
  if (scale < 1) {
    warn.textContent = `⚠ Text scaled to ${Math.round(scale * 100)}% to fit — consider splitting this slide with ---`;
    warn.hidden = false;
  } else {
    warn.hidden = true;
  }
}

function fitSlide() {
  // Stage has a fixed 960x540 design size; scale it to the viewport.
  const scale = Math.min(window.innerWidth / 1020, window.innerHeight / 640);
  slideStage.style.transform = `scale(${scale})`;
  resizeInkCanvas();
}

function gotoSlide(idx) {
  slideIndex = Math.min(slides.length - 1, Math.max(0, idx));
  renderSlide();
  redrawInk();
}

function enterPresenter() {
  slides = splitSlides(getContent());
  slideIndex = slideForCursor();
  presenting = true;
  presenterEl.hidden = false;
  renderSlide();
  fitSlide();
  presenterEl.requestFullscreen?.().catch(() => {});
}

function exitPresenter() {
  presenting = false;
  presenterEl.hidden = true;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  editorView.focus();
}

// Esc in fullscreen fires fullscreenchange, not keydown — tear down there too.
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && presenting) exitPresenter();
});

document.addEventListener('keydown', (e) => {
  if (!presenting) return;
  switch (e.key) {
    case 'ArrowRight': case 'ArrowDown': case ' ': case 'PageDown':
      e.preventDefault(); gotoSlide(slideIndex + 1); break;
    case 'ArrowLeft': case 'ArrowUp': case 'PageUp':
      e.preventDefault(); gotoSlide(slideIndex - 1); break;
    case 'Home': e.preventDefault(); gotoSlide(0); break;
    case 'End': e.preventDefault(); gotoSlide(slides.length - 1); break;
    case 'Escape': e.preventDefault(); exitPresenter(); break;
    // ink
    case 'p': case 'P': e.preventDefault(); setInkMode(ink.mode === 'pen' ? 'off' : 'pen'); break;
    case 'e': case 'E': e.preventDefault(); setInkMode(ink.mode === 'erase' ? 'off' : 'erase'); break;
    case 'c': case 'C': e.preventDefault(); cycleInkColor(); break;
    case 'x': case 'X': e.preventDefault(); ink.strokes.delete(slideIndex); redrawInk(); break;
  }
}, true);

document.getElementById('slide-prev').addEventListener('click', () => gotoSlide(slideIndex - 1));
document.getElementById('slide-next').addEventListener('click', () => gotoSlide(slideIndex + 1));
document.getElementById('presenter-exit').addEventListener('click', exitPresenter);

// Click on the slide advances; click on the left fifth goes back.
presenterEl.addEventListener('click', (e) => {
  if (e.target.closest('#presenter-hud')) return;
  if (e.target.closest('a, .video-embed')) return; // interact, don't navigate
  if (inkConsumesClick()) return; // drawing, not navigating
  if (e.clientX < window.innerWidth / 5) gotoSlide(slideIndex - 1);
  else gotoSlide(slideIndex + 1);
});

window.addEventListener('resize', () => { if (presenting) fitSlide(); });

// ---------------------------------------------------------------------------
// Presenter ink — draw on slides with a digital pen (or mouse via Pen mode)
//
// A stylus (pointerType "pen") draws immediately; its eraser end erases.
// Mouse/touch users toggle the ✎ button. Strokes live in slide coordinates,
// so they stick to the slide across window resizes, and are kept per slide
// for the whole app session. Rough strokes snap to perfect lines & circles.
// ---------------------------------------------------------------------------

const inkCanvas = document.getElementById('ink-canvas');
const inkCtx = inkCanvas.getContext('2d');
const btnInkPen = document.getElementById('ink-pen');
const btnInkColor = document.getElementById('ink-color');
const btnInkErase = document.getElementById('ink-erase');
const btnInkClear = document.getElementById('ink-clear');

const INK_COLORS = ['#e5484d', '#2f6feb', '#1a7f37', '#e8a013', '#111111'];
const INK_SIZE = 3;        // base stroke width in slide units
const ERASE_RADIUS = 14;   // slide units

const ink = {
  mode: 'off',             // 'off' | 'pen' | 'erase' — a stylus always draws
  colorIdx: 0,
  strokes: new Map(),      // slideIndex → [{ color, pts: [{x, y, p}] }]
  current: null,
  drewSinceDown: false,
};

function inkStrokes() {
  if (!ink.strokes.has(slideIndex)) ink.strokes.set(slideIndex, []);
  return ink.strokes.get(slideIndex);
}

// Maps between screen pixels and the slide stage's 960×540 design space.
function stageMap() {
  const r = slideStage.getBoundingClientRect();
  const scale = r.width / 960 || 1;
  return {
    scale,
    from: (e) => ({ x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale, p: e.pressure || 0.5 }),
    toX: (x) => r.left + x * scale,
    toY: (y) => r.top + y * scale,
  };
}

function resizeInkCanvas() {
  const dpr = window.devicePixelRatio || 1;
  inkCanvas.width = Math.round(window.innerWidth * dpr);
  inkCanvas.height = Math.round(window.innerHeight * dpr);
  inkCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  redrawInk();
}

function redrawInk() {
  inkCtx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  const m = stageMap();
  for (const s of ink.strokes.get(slideIndex) || []) drawInkStroke(s, m);
  if (ink.current) drawInkStroke(ink.current, m);
}

function drawInkStroke(s, m) {
  const pts = s.pts;
  if (pts.length === 0) return;
  inkCtx.strokeStyle = s.color;
  inkCtx.lineCap = 'round';
  inkCtx.lineJoin = 'round';
  if (pts.length === 1) {
    inkCtx.lineWidth = INK_SIZE * m.scale;
    inkCtx.beginPath();
    inkCtx.moveTo(m.toX(pts[0].x), m.toY(pts[0].y));
    inkCtx.lineTo(m.toX(pts[0].x) + 0.1, m.toY(pts[0].y));
    inkCtx.stroke();
    return;
  }
  // Per-segment width follows pen pressure; round caps hide the joints.
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]; const b = pts[i];
    inkCtx.lineWidth = INK_SIZE * (0.5 + (a.p + b.p) * 0.7) * m.scale;
    inkCtx.beginPath();
    inkCtx.moveTo(m.toX(a.x), m.toY(a.y));
    inkCtx.lineTo(m.toX(b.x), m.toY(b.y));
    inkCtx.stroke();
  }
}

// ---- shape snapping: straighten near-lines, perfect near-circles ----

function snapStroke(s) {
  const pts = s.pts;
  if (pts.length < 8) return;
  const a = pts[0]; const b = pts[pts.length - 1];
  const chord = Math.hypot(b.x - a.x, b.y - a.y);

  // Line: every point close to the start→end segment.
  if (chord > 40) {
    let maxDev = 0;
    for (const p of pts) {
      const t = Math.max(0, Math.min(1,
        ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / (chord * chord)));
      maxDev = Math.max(maxDev, Math.hypot(p.x - (a.x + t * (b.x - a.x)), p.y - (a.y + t * (b.y - a.y))));
    }
    if (maxDev < Math.max(4, chord * 0.04)) {
      const p = pts.reduce((acc, q) => acc + q.p, 0) / pts.length;
      s.pts = [{ ...a, p }, { ...b, p }];
      return;
    }
  }

  // Circle: radius from the centroid is nearly constant and the stroke
  // sweeps (almost) all the way around.
  const cx = pts.reduce((acc, p) => acc + p.x, 0) / pts.length;
  const cy = pts.reduce((acc, p) => acc + p.y, 0) / pts.length;
  const radii = pts.map((p) => Math.hypot(p.x - cx, p.y - cy));
  const r = radii.reduce((acc, v) => acc + v, 0) / radii.length;
  if (r < 15) return;
  const dev = Math.sqrt(radii.reduce((acc, v) => acc + (v - r) ** 2, 0) / radii.length);
  let sweep = 0;
  for (let i = 1; i < pts.length; i++) {
    let d = Math.atan2(pts[i].y - cy, pts[i].x - cx) - Math.atan2(pts[i - 1].y - cy, pts[i - 1].x - cx);
    if (d > Math.PI) d -= 2 * Math.PI;
    if (d < -Math.PI) d += 2 * Math.PI;
    sweep += d;
  }
  if (dev / r < 0.16 && Math.abs(sweep) > 4.8 && chord < r) {
    const p = pts.reduce((acc, q) => acc + q.p, 0) / pts.length;
    s.pts = Array.from({ length: 49 }, (_, i) => {
      const t = (i / 48) * 2 * Math.PI;
      return { x: cx + r * Math.cos(t), y: cy + r * Math.sin(t), p };
    });
  }
}

// ---- erasing: drop any stroke the eraser path comes near ----

function distToSegment(p, a, b) {
  const len2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
  const t = len2 ? Math.max(0, Math.min(1,
    ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / len2)) : 0;
  return Math.hypot(p.x - (a.x + t * (b.x - a.x)), p.y - (a.y + t * (b.y - a.y)));
}

function eraseAt(pt) {
  const strokes = inkStrokes();
  const keep = strokes.filter((s) => {
    if (s.pts.length === 1) return Math.hypot(s.pts[0].x - pt.x, s.pts[0].y - pt.y) > ERASE_RADIUS;
    for (let i = 1; i < s.pts.length; i++) {
      if (distToSegment(pt, s.pts[i - 1], s.pts[i]) <= ERASE_RADIUS) return false;
    }
    return true;
  });
  if (keep.length !== strokes.length) {
    ink.strokes.set(slideIndex, keep);
    redrawInk();
  }
}

// ---- pointer handling ----

function pointerErases(e) {
  // buttons bit 32 = a stylus' eraser end
  return ink.mode === 'erase' || (e.pointerType === 'pen' && (e.buttons & 32) !== 0);
}

// Pointer listeners live on the presenter, not the canvas: the canvas is
// click-transparent while no draw mode is on (so video players and links in
// slides stay usable), yet a stylus can still start drawing anywhere — the
// events bubble up from whatever slide element it touches. (Starting a
// stroke on top of an embedded video needs the ✎ mode: the iframe swallows
// pointer events before they can bubble.)
presenterEl.addEventListener('pointerdown', (e) => {
  const draws = e.pointerType === 'pen' || ink.mode !== 'off';
  if (!draws || e.target.closest('#presenter-hud')) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  e.preventDefault();
  ink.drewSinceDown = true;
  try { presenterEl.setPointerCapture(e.pointerId); } catch (_) { /* stale pointer id */ }
  const m = stageMap();
  if (pointerErases(e)) {
    ink.current = { erase: true };
    eraseAt(m.from(e));
    return;
  }
  ink.current = { color: INK_COLORS[ink.colorIdx], pts: [m.from(e)] };
  redrawInk();
});

presenterEl.addEventListener('pointermove', (e) => {
  if (!ink.current) return;
  const m = stageMap();
  const coalesced = e.getCoalescedEvents?.();
  const events = coalesced?.length ? coalesced : [e];
  if (ink.current.erase) {
    for (const ev of events) eraseAt(m.from(ev));
    return;
  }
  for (const ev of events) ink.current.pts.push(m.from(ev));
  redrawInk();
});

function finishInkStroke() {
  if (!ink.current) return;
  if (!ink.current.erase) {
    snapStroke(ink.current);
    inkStrokes().push(ink.current);
  }
  ink.current = null;
  redrawInk();
}

presenterEl.addEventListener('pointerup', finishInkStroke);
presenterEl.addEventListener('pointercancel', () => { ink.current = null; redrawInk(); });

// Swallow the click that follows a drawing gesture (and all clicks while a
// draw mode is active — navigation is keyboard/HUD then).
function inkConsumesClick() {
  const drew = ink.drewSinceDown || ink.mode !== 'off';
  ink.drewSinceDown = false;
  return drew;
}

// ---- ink HUD ----

function setInkMode(mode) {
  ink.mode = mode;
  btnInkPen.classList.toggle('active', mode === 'pen');
  btnInkErase.classList.toggle('active', mode === 'erase');
  inkCanvas.classList.toggle('drawing', mode !== 'off');
}

function cycleInkColor() {
  ink.colorIdx = (ink.colorIdx + 1) % INK_COLORS.length;
  btnInkColor.style.color = INK_COLORS[ink.colorIdx];
  if (ink.mode === 'erase') setInkMode('pen');
}

btnInkPen.addEventListener('click', () => setInkMode(ink.mode === 'pen' ? 'off' : 'pen'));
btnInkErase.addEventListener('click', () => setInkMode(ink.mode === 'erase' ? 'off' : 'erase'));
btnInkColor.addEventListener('click', cycleInkColor);
btnInkClear.addEventListener('click', () => { ink.strokes.delete(slideIndex); redrawInk(); });
btnInkColor.style.color = INK_COLORS[ink.colorIdx];

// ---------------------------------------------------------------------------
// File operations
// ---------------------------------------------------------------------------

async function saveDocument({ saveAs = false } = {}) {
  const target = saveAs ? null : activeTab.filePath;
  const savedPath = await window.legilo.saveFile(target, getContent());
  if (!savedPath) return false; // user cancelled Save As
  activeTab.filePath = savedPath;
  activeTab.label = null; // a saved guide tab becomes a normal file tab
  clearDirty();
  saveSession();
  return true;
}

async function openDocument() {
  const result = await window.legilo.openFile();
  if (!result) return;
  if (/\.html?$/i.test(result.filePath)) return importHtml(result.filePath, result.content);
  openPath(result.filePath, result.content);
}

// HTML files are converted to Markdown and opened as a new, unsaved document
// (so saving writes a .md instead of clobbering the original .html).
function importHtml(filePath, html) {
  const turndown = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
  }).use(turndownGfm);
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const markdown = turndown.turndown(doc.body.innerHTML);
  const name = filePath.split(/[\\/]/).pop().replace(/\.html?$/i, '.md');
  const tab = newTab({ content: markdown, label: name });
  tab.dirty = true; // imported, not yet saved as markdown
  renderTabBar();
  updateTitle();
}

function openPath(filePath, content) {
  const existing = tabs.find((t) => t.filePath === filePath);
  if (existing) {
    activateTab(existing);
    return;
  }
  // Reuse a pristine empty tab instead of leaving it dangling
  if (activeTab && !activeTab.filePath && !activeTab.dirty && getContent() === '') {
    activeTab.filePath = filePath;
    activeTab.state = createEditorState(content);
    editorView.setState(activeTab.state);
    editorView.dispatch({ effects: themeCompartment.reconfigure(editorThemeExt()) });
    renderPreview();
    renderTabBar();
    updateTitle();
    saveSession();
    return;
  }
  newTab({ filePath, content });
}

function docTitle() {
  return tabName(activeTab).replace(/\.(md|markdown|mdown|txt)$/i, '');
}

// Standalone light-theme HTML of the current document; used for HTML export,
// PDF export, and printing. Renders via the DOM so relative image paths get
// resolved the same way as in the preview.
async function buildStandaloneHtml() {
  const scratch = document.createElement('div');
  // Exports are always light-theme; wait for diagrams so the SVGs are inlined.
  await renderMarkdownInto(scratch, getContent(), { theme: 'light' });
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${md.utils.escapeHtml(docTitle())}</title>
<style>
${getExportCss()}
</style>
</head>
<body>
<article class="markdown-body">
${scratch.innerHTML}
</article>
</body>
</html>
`;
}

async function exportToHtml() {
  await window.legilo.exportHtml(await buildStandaloneHtml(), `${docTitle()}.html`);
}

// Print from the visible window: fill #print-root, force the light theme,
// and let @media print CSS hide the app chrome. (Printing via a hidden
// window is unreliable on Windows — the dialog never appears.)
async function printDocument() {
  const printRoot = document.getElementById('print-root');
  await renderMarkdownInto(printRoot, getContent(), { theme: 'light' });
  const wasDark = document.body.classList.contains('theme-dark');
  if (wasDark) {
    document.body.classList.replace('theme-dark', 'theme-light');
  }
  window.addEventListener('afterprint', () => {
    if (wasDark) document.body.classList.replace('theme-light', 'theme-dark');
    printRoot.innerHTML = '';
  }, { once: true });
  window.print();
}

// Everything the office exporters need from the app; they render through the
// same pipeline as the preview so styles and diagrams match.
function officeExportCtx() {
  return {
    app,
    getContent,
    docTitle,
    render: renderMarkdownInto,
    splitSlides,
    fitContent,
    paperSizes: PAPER_SIZES,
    slideBaseFont: SLIDE_BASE_FONT,
  };
}

// Pull the preview/GFM rules out of the app stylesheet so the exported HTML
// looks the same as the preview pane.
function getExportCss() {
  let out = 'body{margin:0;padding:2rem;display:flex;justify-content:center;background:#fff}' +
    '.markdown-body{max-width:48rem;width:100%}';
  for (const sheet of document.styleSheets) {
    let rules;
    try { rules = sheet.cssRules; } catch (_) { continue; }
    // KaTeX's stylesheet is included wholesale; its font URLs come out of the
    // CSSOM absolutized against the app, so local print/PDF renders math
    // correctly (an exported HTML falls back to system fonts elsewhere).
    const isKatex = (sheet.href || '').includes('/katex/');
    const isCustom = sheet.ownerNode?.id === 'custom-css';
    for (const rule of rules) {
      const text = rule.cssText || '';
      if (isKatex || isCustom || text.includes('.markdown-body') || text.includes('.hljs') || text.includes('.katex')) {
        // Export uses the light theme: skip dark overrides and presenter rules
        if (text.includes('.theme-dark') || text.includes('#presenter') || text.includes('#slide')) continue;
        // Preview-style presets: keep the active one (unprefixed), drop others
        if (text.includes('body.style-')) {
          if (!text.includes(`body.style-${app.previewStyle} `)) continue;
          out += '\n' + text.replaceAll(`body.style-${app.previewStyle} `, '');
          continue;
        }
        out += '\n' + text.replaceAll('.theme-light ', '');
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Insert helpers — snippets so users don't have to remember the syntax
// ---------------------------------------------------------------------------

// Replaces the selection; selects [selOffset, selOffset+selLen) of the
// inserted text so the placeholder is ready to be typed over.
function insertSnippet(text, selOffset = null, selLen = 0) {
  const { from, to } = editorView.state.selection.main;
  editorView.dispatch({
    changes: { from, to, insert: text },
    selection: selOffset === null
      ? { anchor: from + text.length }
      : { anchor: from + selOffset, head: from + selOffset + selLen },
    scrollIntoView: true,
  });
  editorView.focus();
}

// Wraps the selection (or a placeholder) in before/after markers.
function wrapSelection(before, after, placeholder) {
  const { from, to } = editorView.state.selection.main;
  const inner = editorView.state.sliceDoc(from, to) || placeholder;
  insertSnippet(before + inner + after, before.length, inner.length);
}

// Block snippets want to start on their own line.
function blockPrefix() {
  const { from } = editorView.state.selection.main;
  const line = editorView.state.doc.lineAt(from);
  if (from === line.from) return '';
  return line.text.trim() === '' ? '\n' : '\n\n';
}

async function doInsert(kind) {
  const pre = blockPrefix();
  switch (kind) {
    case 'heading':
      return insertSnippet(`${pre}## `, null);
    case 'bold':
      return wrapSelection('**', '**', 'bold text');
    case 'italic':
      return wrapSelection('*', '*', 'italic text');
    case 'link': {
      const { from, to } = editorView.state.selection.main;
      const label = editorView.state.sliceDoc(from, to) || 'link text';
      const text = `[${label}](https://example.com)`;
      // select the URL so it can be replaced immediately
      return insertSnippet(text, label.length + 3, 'https://example.com'.length);
    }
    case 'image': {
      const imgPath = await window.legilo.pickImage();
      if (!imgPath) return;
      let src = imgPath.replaceAll('\\', '/');
      const docDir = activeTab.filePath
        ? activeTab.filePath.replaceAll('\\', '/').split('/').slice(0, -1).join('/')
        : null;
      if (docDir && src.startsWith(docDir + '/')) {
        src = src.slice(docDir.length + 1); // same folder as the doc: keep it relative
      }
      // otherwise keep the plain absolute path (C:/… or /…) — the preview
      // resolves it against the file:// origin, and it stays readable
      const name = imgPath.split(/[\\/]/).pop();
      const text = `${pre}![${name}](<${src}>)`;
      return insertSnippet(text, pre.length + 2, name.length); // select the alt text
    }
    case 'code': {
      const text = `${pre}\`\`\`javascript\ncode\n\`\`\`\n`;
      return insertSnippet(text, pre.length + 3, 'javascript'.length); // select the language
    }
    case 'mermaid': {
      const body = 'flowchart LR\n  A[Start] --> B{Decision}\n  B -->|yes| C[Do it]\n  B -->|no| D[Skip it]';
      return insertSnippet(`${pre}\`\`\`mermaid\n${body}\n\`\`\`\n`, 0, 0);
    }
    case 'd2': {
      const body = 'user: User\napp: Legilo\nuser -> app: writes markdown\napp -> user: renders preview';
      return insertSnippet(`${pre}\`\`\`d2\n${body}\n\`\`\`\n`, 0, 0);
    }
    case 'video': {
      const url = 'https://youtu.be/VIDEO_ID';
      return insertSnippet(`${pre}${url}\n`, pre.length + url.length - 'VIDEO_ID'.length, 'VIDEO_ID'.length);
    }
    case 'table':
      return insertSnippet(
        `${pre}| Column 1 | Column 2 | Column 3 |\n| --- | --- | --- |\n| cell | cell | cell |\n| cell | cell | cell |\n`,
        pre.length + 2, 'Column 1'.length);
    case 'tasklist':
      return insertSnippet(`${pre}- [ ] First task\n- [ ] Second task\n- [x] Done task\n`,
        pre.length + 6, 'First task'.length);
    case 'quote':
      return insertSnippet(`${pre}> Quoted text\n`, pre.length + 2, 'Quoted text'.length);
    case 'footnote':
      return insertSnippet(`Text with a footnote.[^1]\n\n[^1]: The footnote itself.\n`, 0, 0);
    case 'slide':
      return insertSnippet(`${pre}---\n\n`, null);
    case 'pagebreak':
      return insertSnippet(`${pre}\\pagebreak\n\n`, null);
  }
}

// ---------------------------------------------------------------------------
// Menu & app lifecycle wiring
// ---------------------------------------------------------------------------

window.legilo.onMenu(async (action) => {
  if (action.startsWith('insert:')) return doInsert(action.slice(7));
  switch (action) {
    case 'print': return printDocument();
    case 'print-preview': return window.legilo.printPreview(await buildStandaloneHtml(), app.paperSize);
    case 'export-pdf': return window.legilo.exportPdf(await buildStandaloneHtml(), `${docTitle()}.pdf`, app.paperSize);
    case 'new': return newTab();
    case 'open': return openDocument();
    case 'close-tab': return closeTab(activeTab);
    case 'next-tab': return cycleTab(1);
    case 'prev-tab': return cycleTab(-1);
    case 'save': return saveDocument();
    case 'save-as': return saveDocument({ saveAs: true });
    case 'export-html': return exportToHtml();
    case 'export-docx': return exportOfficeDocx(officeExportCtx());
    case 'export-pptx': return exportOfficePptx(officeExportCtx());
    case 'view-split': return applyViewMode('split');
    case 'view-editor': return applyViewMode('editor');
    case 'view-preview': return applyViewMode('preview');
    case 'toggle-theme': return applyTheme(app.theme === 'dark' ? 'light' : 'dark');
    case 'find': case 'replace': {
      // the search panel lives in the editor — make sure it's visible
      if (app.viewMode === 'preview') applyViewMode('split');
      editorView.focus();
      return openSearchPanel(editorView);
    }
    default:
      if (action.startsWith('style-') && PREVIEW_STYLES.includes(action.slice(6))) {
        return applyPreviewStyle(action.slice(6));
      }
      break;
    case 'custom-css-load': return loadCustomCss();
    case 'custom-css-clear': return setCustomCss('');
    case 'preview-flow': return applyPreviewMode('flow');
    case 'preview-page': return applyPreviewMode('page');
    case 'preview-slides': return applyPreviewMode('slides');
    case 'cycle-preview': return cyclePreviewMode();
    case 'paper-A4': return applyPaperSize('A4');
    case 'paper-Letter': return applyPaperSize('Letter');
    case 'presenter': return presenting ? exitPresenter() : enterPresenter();
    case 'show-guide': return showGuide();
  }
});

window.legilo.onCloseRequest(async () => {
  for (const tab of [...tabs]) {
    if (!tab.dirty) continue;
    activateTab(tab);
    const choice = await window.legilo.confirmUnsaved(tabName(tab));
    if (choice === 'cancel') return; // abort close
    if (choice === 'save' && !(await saveDocument())) return;
  }
  saveSession();
  window.legilo.closeNow();
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

const GUIDE = `# Welcome to Legilo

A split-view **Markdown** editor: type on the left, read on the right.
This guide doubles as a Markdown cheat sheet — compare the two panes to
see how everything works. Close this tab any time; reopen it via
**Help → Markdown Guide**.

## The basics

### Headings use \`#\` to \`######\`

**bold text**, *italic text*, \`inline code\`, and a
[link](https://www.markdownguide.org) — links open in your browser.

> A quote looks like this.

Lists:

- an item
- another item
  - an indented item

1. first
2. second

## Images

Use **Insert → Image…** to pick a file — the path is filled in for you:

![alt text](image.png)

Images that sit next to your saved document use just the file name.

## Tables

| Syntax | Result |
| --- | --- |
| \`**bold**\` | **bold** |
| \`*italic*\` | *italic* |
| \`[link](url)\` | [link](https://example.com) |

## Task lists

- [x] Learn the basics
- [ ] Write something great

## Code blocks

\`\`\`javascript
function greet(name) {
  return \`Saluton, \${name}!\`; // "Legilo" is Esperanto for reading device
}
\`\`\`

## Footnotes

Here is a footnote reference.[^1]

[^1]: And here is the footnote itself.

## Math

Inline math between dollar signs, like $E = mc^2$, or display math:

$$
Q = \\frac{\\Delta S}{\\Delta t} + \\sum_{i} q_i
$$

## Diagrams

Fenced code blocks with the language \`mermaid\` or \`d2\` render as
diagrams (also in slides, print, and exports — try the Insert menu):

\`\`\`mermaid
flowchart LR
  A[Write markdown] --> B{Happy?}
  B -->|yes| C[Present it]
  B -->|no| A
\`\`\`

\`\`\`d2
editor: Editor
preview: Preview
editor -> preview: live render
\`\`\`

## Video

A bare YouTube or Vimeo link on a line of its own becomes an embedded
player (a labeled [link](https://youtu.be/dQw4w9WgXcQ) stays a link):

https://www.youtube.com/watch?v=dQw4w9WgXcQ

Local video files work too — link a \`.mp4\`/\`.webm\` file with the path as
its own text, alone on a line: \`[clip.mp4](clip.mp4)\`

\\pagebreak

## Page breaks

The line \`\\pagebreak\` (just above this heading) forces a new page when
printing, exporting to PDF, or in **page view** (Ctrl+Shift+P) — try it!
In the normal preview it shows as a dashed marker. It's also in the
Insert menu.

---

## Slides

A \`---\` line starts a new slide for **presenter mode**: press **F5**
to present this document, ←/→ to navigate, Esc to leave.

While presenting you can **draw on the slides**: a digital pen just works
(its eraser end erases); with a mouse, toggle ✎ in the corner or press
**P**. Sloppy circles and lines snap into perfect ones. **E** = eraser,
**C** = pen colour, **X** = clear the slide.

---

## Looks

**View → Preview Style** restyles the preview (and every export):
GitHub, Book, Minimal, Academic (numbered sections), Slate, Typewriter,
or Newspaper — or load your own CSS with **Load Custom CSS…**.

---

## Export

**File → Export** turns this document into other formats — each one keeps the
preview style you picked above:

- **HTML** and **PDF** — styled, with math, code highlighting, and diagrams
- **Word (.docx)** — a flowing, editable document; \`\\pagebreak\` and page
  size carry over
- **PowerPoint (.pptx)** — one slide per \`---\`, laid out like presenter
  mode. If a slide is too full it's scaled to fit, exactly as Legilo shows it.

---

## Handy shortcuts

| Shortcut | Action |
| --- | --- |
| Ctrl+N / Ctrl+W / Ctrl+Tab | New / close / switch tab |
| Ctrl+S / Ctrl+Shift+S | Save / Save As |
| Ctrl+B / Ctrl+I / Ctrl+K | Bold / italic / link |
| Ctrl+F / Ctrl+H | Find / replace |
| Ctrl+P | Print |
| Ctrl+E | Export to HTML |
| Ctrl+Shift+P | Preview layout: flow / page / slides |
| Ctrl+Shift+D | Dark theme on/off |
| Ctrl+1 / 2 / 3 | Split / editor / preview |
| F5 | Presenter mode |
| P / E / C / X | While presenting: pen / eraser / colour / clear ink |
`;

const GUIDE_LABEL = 'Markdown Guide';

function showGuide() {
  const existing = tabs.find((t) => t.label === GUIDE_LABEL);
  if (existing) activateTab(existing);
  else newTab({ content: GUIDE, label: GUIDE_LABEL });
}

(async function init() {
  const prefs = await window.legilo.getPrefs();
  applyTheme(prefs.theme || 'light');
  applyViewMode(prefs.viewMode || 'split');
  app.paperSize = prefs.paperSize || 'A4';
  applyPreviewStyle(prefs.previewStyle || 'github');
  if (prefs.customCssPath) {
    const css = await window.legilo.readFile(prefs.customCssPath);
    if (css !== null) setCustomCss(css);
  }
  applyPreviewMode(prefs.previewMode || 'flow');

  const session = await window.legilo.getSession();
  for (const filePath of session?.files || []) {
    const content = await window.legilo.readFile(filePath);
    if (content !== null) newTab({ filePath, content });
  }
  const active = tabs.find((t) => t.filePath === session?.active);
  if (active) activateTab(active);
  // Guide in front on launch — Help → "Show Guide on Startup" turns this off,
  // but always show it when there would otherwise be no tab at all.
  if (prefs.showGuideOnStartup !== false || tabs.length === 0) showGuide();
  editorView.focus();
})();