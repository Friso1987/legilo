const { app, BrowserWindow, Menu, ipcMain, dialog, shell, clipboard, session } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const Store = require('electron-store');

const store = new Store({
  defaults: {
    windowBounds: { width: 1280, height: 800 },
    theme: 'light',
    viewMode: 'split',
    showGuideOnStartup: true,
  },
});

let win = null;
let allowClose = false;

function createWindow() {
  const bounds = store.get('windowBounds');

  win = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: 600,
    minHeight: 400,
    title: 'Legilo',
    icon: path.join(__dirname, 'logo', 'icon-256.png'),
    backgroundColor: store.get('theme') === 'dark' ? '#1e2227' : '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Links in the preview open in the system browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    e.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });

  // The renderer owns the dirty-state check: intercept close, let the
  // renderer confirm/save, and it calls app:close-now when it's safe.
  win.on('close', (e) => {
    if (allowClose) return;
    e.preventDefault();
    store.set('windowBounds', win.getBounds());
    win.webContents.send('app:close-request');
  });

  win.on('closed', () => {
    win = null;
  });

  // Right-click menus: spelling fixes on misspellings; cut/copy + formatting
  // on an editor selection; paste + Insert without one; copy/link actions in
  // the preview.
  win.webContents.on('context-menu', (_e, p) => {
    const template = [];

    if (p.misspelledWord) {
      for (const s of p.dictionarySuggestions.slice(0, 5)) {
        template.push({ label: s, click: () => win.webContents.replaceMisspelling(s) });
      }
      if (p.dictionarySuggestions.length === 0) {
        template.push({ label: 'No suggestions', enabled: false });
      }
      template.push({
        label: `Add "${p.misspelledWord}" to Dictionary`,
        click: () => win.webContents.session.addWordToSpellCheckerDictionary(p.misspelledWord),
      });
      template.push({ type: 'separator' });
    }

    if (p.linkURL) {
      template.push(
        { label: 'Open Link in Browser', click: () => shell.openExternal(p.linkURL) },
        { label: 'Copy Link Address', click: () => clipboard.writeText(p.linkURL) },
        { type: 'separator' },
      );
    }

    if (p.isEditable) {
      const hasSelection = p.selectionText.trim().length > 0;
      if (hasSelection) {
        template.push(
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { type: 'separator' },
          { label: 'Bold', accelerator: 'CmdOrCtrl+B', click: () => sendMenu('insert:bold') },
          { label: 'Italic', accelerator: 'CmdOrCtrl+I', click: () => sendMenu('insert:italic') },
          { label: 'Link', accelerator: 'CmdOrCtrl+K', click: () => sendMenu('insert:link') },
        );
      } else {
        template.push(
          { role: 'paste' },
          { role: 'selectAll' },
          { type: 'separator' },
          { label: 'Insert', submenu: insertMenuTemplate() },
        );
      }
    } else if (p.selectionText.trim()) {
      template.push({ role: 'copy' });
    }

    while (template.length && template[template.length - 1].type === 'separator') template.pop();
    if (template.length) Menu.buildFromTemplate(template).popup({ window: win });
  });
}

function sendMenu(action) {
  if (win) win.webContents.send('menu', action);
}

// previewMode with migration from the old boolean pageView pref.
function getPreviewMode() {
  return store.get('previewMode') ?? (store.get('pageView') ? 'page' : 'flow');
}

// Shared between the menu bar and the toolbar's Insert dropdown.
function insertMenuTemplate() {
  return [
    { label: 'Heading', click: () => sendMenu('insert:heading') },
    { label: 'Bold', accelerator: 'CmdOrCtrl+B', click: () => sendMenu('insert:bold') },
    { label: 'Italic', accelerator: 'CmdOrCtrl+I', click: () => sendMenu('insert:italic') },
    { type: 'separator' },
    { label: 'Link', accelerator: 'CmdOrCtrl+K', click: () => sendMenu('insert:link') },
    { label: 'Image…', click: () => sendMenu('insert:image') },
    { type: 'separator' },
    { label: 'Code Block', click: () => sendMenu('insert:code') },
    { label: 'Mermaid Diagram', click: () => sendMenu('insert:mermaid') },
    { label: 'D2 Diagram', click: () => sendMenu('insert:d2') },
    { label: 'Video (YouTube/Vimeo)…', click: () => sendMenu('insert:video') },
    { label: 'Table', click: () => sendMenu('insert:table') },
    { label: 'Task List', click: () => sendMenu('insert:tasklist') },
    { label: 'Quote', click: () => sendMenu('insert:quote') },
    { label: 'Footnote', click: () => sendMenu('insert:footnote') },
    { type: 'separator' },
    { label: 'Slide Separator (---)', click: () => sendMenu('insert:slide') },
    { label: 'Page Break', click: () => sendMenu('insert:pagebreak') },
  ];
}

function buildMenu() {
  const template = [
    // macOS expects the application menu first
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Tab', accelerator: 'CmdOrCtrl+N', click: () => sendMenu('new') },
        { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: () => sendMenu('open') },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => sendMenu('close-tab') },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => sendMenu('save') },
        { label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', click: () => sendMenu('save-as') },
        { type: 'separator' },
        { label: 'Export to HTML…', accelerator: 'CmdOrCtrl+E', click: () => sendMenu('export-html') },
        { label: 'Export to PDF…', click: () => sendMenu('export-pdf') },
        { label: 'Export to Word…', click: () => sendMenu('export-docx') },
        { label: 'Export to PowerPoint…', click: () => sendMenu('export-pptx') },
        { type: 'separator' },
        { label: 'Print…', accelerator: 'CmdOrCtrl+P', click: () => sendMenu('print') },
        { label: 'Print Preview', click: () => sendMenu('print-preview') },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Find…', accelerator: 'CmdOrCtrl+F', click: () => sendMenu('find') },
        { label: 'Replace…', accelerator: 'CmdOrCtrl+H', click: () => sendMenu('replace') },
      ],
    },
    {
      label: 'Insert',
      submenu: insertMenuTemplate(),
    },
    {
      label: 'View',
      submenu: [
        { label: 'Split View', accelerator: 'CmdOrCtrl+1', click: () => sendMenu('view-split') },
        { label: 'Editor Only', accelerator: 'CmdOrCtrl+2', click: () => sendMenu('view-editor') },
        { label: 'Preview Only', accelerator: 'CmdOrCtrl+3', click: () => sendMenu('view-preview') },
        { type: 'separator' },
        { label: 'Presenter Mode', accelerator: 'F5', click: () => sendMenu('presenter') },
        {
          label: 'Preview Layout',
          submenu: [
            { type: 'radio', label: 'Flow', checked: getPreviewMode() === 'flow', click: () => sendMenu('preview-flow') },
            { type: 'radio', label: 'Page', checked: getPreviewMode() === 'page', click: () => sendMenu('preview-page') },
            { type: 'radio', label: 'Slides', checked: getPreviewMode() === 'slides', click: () => sendMenu('preview-slides') },
            { type: 'separator' },
            { label: 'Cycle Layout', accelerator: 'CmdOrCtrl+Shift+P', click: () => sendMenu('cycle-preview') },
          ],
        },
        {
          label: 'Preview Style',
          submenu: [
            { type: 'radio', label: 'GitHub', checked: store.get('previewStyle', 'github') === 'github', click: () => sendMenu('style-github') },
            { type: 'radio', label: 'Book', checked: store.get('previewStyle', 'github') === 'book', click: () => sendMenu('style-book') },
            { type: 'radio', label: 'Minimal', checked: store.get('previewStyle', 'github') === 'minimal', click: () => sendMenu('style-minimal') },
            { type: 'radio', label: 'Academic', checked: store.get('previewStyle', 'github') === 'academic', click: () => sendMenu('style-academic') },
            { type: 'radio', label: 'Slate', checked: store.get('previewStyle', 'github') === 'slate', click: () => sendMenu('style-slate') },
            { type: 'radio', label: 'Typewriter', checked: store.get('previewStyle', 'github') === 'typewriter', click: () => sendMenu('style-typewriter') },
            { type: 'radio', label: 'Newspaper', checked: store.get('previewStyle', 'github') === 'newspaper', click: () => sendMenu('style-newspaper') },
            { type: 'separator' },
            { label: 'Load Custom CSS…', click: () => sendMenu('custom-css-load') },
            { label: 'Clear Custom CSS', enabled: !!store.get('customCssPath'), click: () => { store.delete('customCssPath'); buildMenu(); sendMenu('custom-css-clear'); } },
          ],
        },
        {
          label: 'Paper Size',
          submenu: [
            { type: 'radio', label: 'A4', checked: store.get('paperSize', 'A4') === 'A4', click: () => sendMenu('paper-A4') },
            { type: 'radio', label: 'US Letter', checked: store.get('paperSize', 'A4') === 'Letter', click: () => sendMenu('paper-Letter') },
          ],
        },
        { type: 'separator' },
        { label: 'Next Tab', accelerator: 'Ctrl+Tab', click: () => sendMenu('next-tab') },
        { label: 'Previous Tab', accelerator: 'Ctrl+Shift+Tab', click: () => sendMenu('prev-tab') },
        { type: 'separator' },
        { label: 'Toggle Dark Theme', accelerator: 'CmdOrCtrl+Shift+D', click: () => sendMenu('toggle-theme') },
        { type: 'separator' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { role: 'resetZoom' },
        { type: 'separator' },
        { role: 'toggleDevTools' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Markdown Guide', click: () => sendMenu('show-guide') },
        { type: 'separator' },
        {
          type: 'checkbox',
          label: 'Show Guide on Startup',
          checked: store.get('showGuideOnStartup'),
          click: (item) => store.set('showGuideOnStartup', item.checked),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------- IPC ----------

const MD_FILTERS = [
  { name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'txt'] },
  { name: 'All Files', extensions: ['*'] },
];

const OPEN_FILTERS = [
  { name: 'Markdown & HTML', extensions: ['md', 'markdown', 'mdown', 'txt', 'html', 'htm'] },
  { name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'txt'] },
  { name: 'HTML', extensions: ['html', 'htm'] },
  { name: 'All Files', extensions: ['*'] },
];

ipcMain.handle('dialog:open', async () => {
  const result = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: OPEN_FILTERS,
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const filePath = result.filePaths[0];
  const content = await fs.readFile(filePath, 'utf8');
  return { filePath, content };
});

ipcMain.on('menu:popup-insert', () => {
  Menu.buildFromTemplate(insertMenuTemplate()).popup({ window: win });
});

ipcMain.handle('dialog:pick-image', async () => {
  const result = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [
      { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// Pick a user stylesheet for the preview; remembers the path for next launch.
ipcMain.handle('dialog:pick-custom-css', async () => {
  const result = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: 'CSS', extensions: ['css'] }],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const cssPath = result.filePaths[0];
  try {
    const css = await fs.readFile(cssPath, 'utf8');
    store.set('customCssPath', cssPath);
    buildMenu(); // enable "Clear Custom CSS"
    return css;
  } catch (_) {
    return null;
  }
});

// Reads a file by path (used for session restore); null when unreadable.
ipcMain.handle('file:read', async (_e, filePath) => {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (_) {
    return null;
  }
});

// Saves content; shows a Save As dialog when filePath is null.
// Returns the final path, or null if the user cancelled.
ipcMain.handle('file:save', async (_e, { filePath, content }) => {
  let target = filePath;
  if (!target) {
    const result = await dialog.showSaveDialog(win, {
      filters: MD_FILTERS,
      defaultPath: 'untitled.md',
    });
    if (result.canceled || !result.filePath) return null;
    target = result.filePath;
  }
  await fs.writeFile(target, content, 'utf8');
  return target;
});

ipcMain.handle('file:export-html', async (_e, { html, defaultName }) => {
  const result = await dialog.showSaveDialog(win, {
    filters: [{ name: 'HTML', extensions: ['html'] }],
    defaultPath: defaultName || 'export.html',
  });
  if (result.canceled || !result.filePath) return null;
  await fs.writeFile(result.filePath, html, 'utf8');
  return result.filePath;
});

// Saves renderer-built binary exports (.docx / .pptx). `data` arrives as a
// Uint8Array over structured clone.
const OFFICE_FILTERS = {
  docx: [{ name: 'Word Document', extensions: ['docx'] }],
  pptx: [{ name: 'PowerPoint Presentation', extensions: ['pptx'] }],
};

ipcMain.handle('file:export-office', async (_e, { data, defaultName, kind }) => {
  const result = await dialog.showSaveDialog(win, {
    filters: OFFICE_FILTERS[kind] || [{ name: 'All Files', extensions: ['*'] }],
    defaultPath: defaultName || `export.${kind}`,
  });
  if (result.canceled || !result.filePath) return null;
  await fs.writeFile(result.filePath, Buffer.from(data));
  return result.filePath;
});

// Binary file read as a data: URL — the renderer needs image/font bytes for
// office exports, and file:// resources taint a canvas there.
const DATA_URL_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  svg: 'image/svg+xml', webp: 'image/webp', bmp: 'image/bmp',
  woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
};

ipcMain.handle('file:read-binary', async (_e, filePath) => {
  try {
    const buf = await fs.readFile(filePath);
    const ext = path.extname(filePath).slice(1).toLowerCase();
    const mime = DATA_URL_MIME[ext] || 'application/octet-stream';
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch (_) {
    return null;
  }
});

// Loads standalone HTML (as produced by the renderer's export) into a hidden
// window, so printing always uses the clean light-theme document.
async function loadPrintWindow(html) {
  const tmpFile = path.join(app.getPath('temp'), `legilo-print-${Date.now()}.html`);
  await fs.writeFile(tmpFile, html, 'utf8');
  const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  await w.loadFile(tmpFile);
  return { w, tmpFile };
}

// "Preview" = render to a temp PDF and open it in the system PDF viewer,
// which doubles as a place to print from.
ipcMain.handle('file:print-preview', async (_e, { html, paperSize }) => {
  const { w, tmpFile } = await loadPrintWindow(html);
  try {
    const pdf = await w.webContents.printToPDF({ printBackground: true, pageSize: paperSize || 'A4' });
    const pdfFile = path.join(app.getPath('temp'), `legilo-preview-${Date.now()}.pdf`);
    await fs.writeFile(pdfFile, pdf);
    await shell.openPath(pdfFile);
    return pdfFile;
  } finally {
    w.destroy();
    fs.unlink(tmpFile).catch(() => {});
  }
});

ipcMain.handle('file:export-pdf', async (_e, { html, defaultName, paperSize }) => {
  const result = await dialog.showSaveDialog(win, {
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
    defaultPath: defaultName || 'export.pdf',
  });
  if (result.canceled || !result.filePath) return null;
  const { w, tmpFile } = await loadPrintWindow(html);
  try {
    const pdf = await w.webContents.printToPDF({ printBackground: true, pageSize: paperSize || 'A4' });
    await fs.writeFile(result.filePath, pdf);
    return result.filePath;
  } finally {
    w.destroy();
    fs.unlink(tmpFile).catch(() => {});
  }
});

// Save / Don't Save / Cancel prompt for unsaved changes.
ipcMain.handle('dialog:confirm-unsaved', async (_e, { fileName }) => {
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Save', "Don't Save", 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    message: `Do you want to save the changes you made to ${fileName}?`,
    detail: "Your changes will be lost if you don't save them.",
  });
  return ['save', 'discard', 'cancel'][response];
});

ipcMain.handle('app:close-now', () => {
  allowClose = true;
  if (win) win.close();
});

ipcMain.on('window:set-title', (_e, title) => {
  if (win) win.setTitle(title);
});

ipcMain.handle('prefs:get', () => ({
  theme: store.get('theme'),
  viewMode: store.get('viewMode'),
  previewMode: getPreviewMode(),
  paperSize: store.get('paperSize', 'A4'),
  previewStyle: store.get('previewStyle', 'github'),
  customCssPath: store.get('customCssPath', null),
  showGuideOnStartup: store.get('showGuideOnStartup'),
}));

const PREF_KEYS = ['theme', 'viewMode', 'previewMode', 'paperSize', 'previewStyle'];
const MENU_PREF_KEYS = ['previewMode', 'paperSize', 'previewStyle'];

ipcMain.on('prefs:set', (_e, { key, value }) => {
  if (!PREF_KEYS.includes(key)) return;
  store.set(key, value);
  // keep the View-menu radio items in sync
  if (MENU_PREF_KEYS.includes(key)) buildMenu();
});

// Open tabs (file paths + active index), restored on next launch.
ipcMain.handle('session:get', () => store.get('session', null));

ipcMain.on('session:set', (_e, session) => {
  store.set('session', session);
});

// ---------- lifecycle ----------

app.whenReady().then(() => {
  // YouTube's embedded player refuses to play without a Referer header
  // (error 153), and a file://-loaded page sends none — add one for the
  // embed frames. Vimeo gets the same treatment for referer-locked videos.
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ['https://www.youtube-nocookie.com/embed/*', 'https://player.vimeo.com/video/*'] },
    (details, callback) => {
      details.requestHeaders['Referer'] = 'https://legilo.app/';
      callback({ requestHeaders: details.requestHeaders });
    },
  );

  buildMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});
