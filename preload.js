const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('legilo', {
  // main -> renderer
  onMenu: (cb) => ipcRenderer.on('menu', (_e, action) => cb(action)),
  onCloseRequest: (cb) => ipcRenderer.on('app:close-request', () => cb()),
  onAudienceState: (cb) => ipcRenderer.on('audience:state', (_e, state) => cb(state)),

  // dual-view presenting
  openAudience: () => ipcRenderer.invoke('presenter:open-audience'),
  closeAudience: () => ipcRenderer.send('presenter:close-audience'),
  syncAudience: (state) => ipcRenderer.send('presenter:sync', state),

  // renderer -> main
  openFile: () => ipcRenderer.invoke('dialog:open'),
  pickImage: () => ipcRenderer.invoke('dialog:pick-image'),
  pickCustomCss: () => ipcRenderer.invoke('dialog:pick-custom-css'),
  popupInsertMenu: () => ipcRenderer.send('menu:popup-insert'),
  readFile: (filePath) => ipcRenderer.invoke('file:read', filePath),
  getSession: () => ipcRenderer.invoke('session:get'),
  setSession: (session) => ipcRenderer.send('session:set', session),
  getRecovery: () => ipcRenderer.invoke('recovery:get'),
  setRecovery: (data) => ipcRenderer.send('recovery:set', data),
  clearRecovery: () => ipcRenderer.send('recovery:clear'),
  saveFile: (filePath, content) => ipcRenderer.invoke('file:save', { filePath, content }),
  exportHtml: (html, defaultName) => ipcRenderer.invoke('file:export-html', { html, defaultName }),
  exportPdf: (html, defaultName, paperSize) => ipcRenderer.invoke('file:export-pdf', { html, defaultName, paperSize }),
  exportOffice: (data, defaultName, kind) => ipcRenderer.invoke('file:export-office', { data, defaultName, kind }),
  readFileBinary: (filePath) => ipcRenderer.invoke('file:read-binary', filePath),
  printPreview: (html, paperSize) => ipcRenderer.invoke('file:print-preview', { html, paperSize }),
  confirmUnsaved: (fileName) => ipcRenderer.invoke('dialog:confirm-unsaved', { fileName }),
  closeNow: () => ipcRenderer.invoke('app:close-now'),
  setTitle: (title) => ipcRenderer.send('window:set-title', title),
  getPrefs: () => ipcRenderer.invoke('prefs:get'),
  setPref: (key, value) => ipcRenderer.send('prefs:set', { key, value }),

  // AI (optional local model)
  aiStatus: () => ipcRenderer.invoke('ai:status'),
  aiGenerate: (payload) => ipcRenderer.send('ai:generate', payload),
  aiCancel: () => ipcRenderer.send('ai:cancel'),
  onAiChunk: (cb) => ipcRenderer.on('ai:chunk', (_e, text) => cb(text)),
  onAiDone: (cb) => ipcRenderer.on('ai:done', () => cb()),
  onAiError: (cb) => ipcRenderer.on('ai:error', (_e, msg) => cb(msg)),
});
