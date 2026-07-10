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

// ---------------------------------------------------------------------------
// Markdown renderer
// ---------------------------------------------------------------------------

const md = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
  highlight(code, lang) {
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

function renderMarkdownInto(el, src) {
  el.innerHTML = md.render(src);
  // Resolve relative image paths against the document's folder so local
  // images (inserted via Insert → Image…) show up in the preview.
  const docDir = activeTab?.filePath
    ? activeTab.filePath.replaceAll('\\', '/').split('/').slice(0, -1).join('/')
    : null;
  for (const img of el.querySelectorAll('img')) {
    const src2 = img.getAttribute('src') || '';
    if (docDir && src2 && !/^[a-z][a-z0-9+.-]*:|^\//i.test(src2)) {
      img.src = 'file:///' + encodeURI(`${docDir}/${src2}`.replace(/^\//, ''));
    }
  }
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
  renderMarkdownInto(scratch, getContent());

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
    renderMarkdownInto(body, part.text);
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

const PREVIEW_STYLES = ['github', 'book', 'minimal'];

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
  renderMarkdownInto(slideEl, slides[slideIndex].text);
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
}

function gotoSlide(idx) {
  slideIndex = Math.min(slides.length - 1, Math.max(0, idx));
  renderSlide();
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
  }
}, true);

document.getElementById('slide-prev').addEventListener('click', () => gotoSlide(slideIndex - 1));
document.getElementById('slide-next').addEventListener('click', () => gotoSlide(slideIndex + 1));
document.getElementById('presenter-exit').addEventListener('click', exitPresenter);

// Click on the slide advances; click on the left fifth goes back.
presenterEl.addEventListener('click', (e) => {
  if (e.target.closest('#presenter-hud')) return;
  if (e.clientX < window.innerWidth / 5) gotoSlide(slideIndex - 1);
  else gotoSlide(slideIndex + 1);
});

window.addEventListener('resize', () => { if (presenting) fitSlide(); });

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
function buildStandaloneHtml() {
  const scratch = document.createElement('div');
  renderMarkdownInto(scratch, getContent());
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
  await window.legilo.exportHtml(buildStandaloneHtml(), `${docTitle()}.html`);
}

// Print from the visible window: fill #print-root, force the light theme,
// and let @media print CSS hide the app chrome. (Printing via a hidden
// window is unreliable on Windows — the dialog never appears.)
function printDocument() {
  const printRoot = document.getElementById('print-root');
  renderMarkdownInto(printRoot, getContent());
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
    case 'print-preview': return window.legilo.printPreview(buildStandaloneHtml(), app.paperSize);
    case 'export-pdf': return window.legilo.exportPdf(buildStandaloneHtml(), `${docTitle()}.pdf`, app.paperSize);
    case 'new': return newTab();
    case 'open': return openDocument();
    case 'close-tab': return closeTab(activeTab);
    case 'next-tab': return cycleTab(1);
    case 'prev-tab': return cycleTab(-1);
    case 'save': return saveDocument();
    case 'save-as': return saveDocument({ saveAs: true });
    case 'export-html': return exportToHtml();
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
    case 'style-github': return applyPreviewStyle('github');
    case 'style-book': return applyPreviewStyle('book');
    case 'style-minimal': return applyPreviewStyle('minimal');
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