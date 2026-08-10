// Headless smoke test for the audience (projector) render path.
// Run: xvfb-run -a npx electron --no-sandbox scripts/smoke-present.js
//
// Boots the real app (via main.js), opens a second window in audience role,
// pushes slide state over the same `audience:state` channel the editor uses,
// and asserts fragments reveal step by step, speaker notes are stripped, and
// blackout covers the slide.

const path = require('path');
const { app, BrowserWindow } = require('electron');

require(path.join(process.cwd(), 'main.js')); // boots the editor window + IPC

const DOC = [
  '# Slide One',
  '',
  '- Alpha',
  '',
  '. . .',
  '',
  '- Beta',
  '',
  '<!-- note: remember to breathe -->',
].join('\n');

function state(extra) {
  return Object.assign({
    slideText: DOC,
    slideIndex: 0,
    slideCount: 3,
    revealStep: 0,
    theme: 'light',
    previewStyle: 'github',
    customCss: '',
    docDir: null,
    blackout: 'off',
    spotlight: false,
    spotlightPos: { x: 0.5, y: 0.5 },
    strokes: [],
  }, extra);
}

const READ = `(() => {
  const frags = [...document.querySelectorAll('#slide .fragment')];
  return {
    count: frags.length,
    shown: frags.map((f) => f.classList.contains('shown')),
    hasNote: document.getElementById('slide').textContent.includes('remember to breathe'),
    blackout: !document.getElementById('slide-blackout').hidden,
    blackoutBlack: document.getElementById('slide-blackout').classList.contains('black'),
  };
})()`;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  const w = new BrowserWindow({
    width: 1280,
    height: 720,
    show: false,
    webPreferences: {
      preload: path.join(process.cwd(), 'preload.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  await w.loadFile(path.join(process.cwd(), 'renderer', 'index.html'), { search: 'role=audience' });
  await wait(400);

  const results = {};

  w.webContents.send('audience:state', state({ revealStep: 0 }));
  await wait(300);
  results.step0 = await w.webContents.executeJavaScript(READ);

  w.webContents.send('audience:state', state({ revealStep: 1 }));
  await wait(300);
  results.step1 = await w.webContents.executeJavaScript(READ);

  w.webContents.send('audience:state', state({ revealStep: 1, blackout: 'black' }));
  await wait(300);
  results.black = await w.webContents.executeJavaScript(READ);

  const ok =
    results.step0.count === 2 &&
    results.step0.shown[0] === true && results.step0.shown[1] === false &&
    results.step1.shown[1] === true &&
    results.step0.hasNote === false &&
    results.black.blackout === true && results.black.blackoutBlack === true;

  console.log('SMOKE RESULTS:', JSON.stringify(results, null, 2));
  console.log(ok ? 'SMOKE PASS ✅' : 'SMOKE FAIL ❌');
  app.exit(ok ? 0 : 1);
}

app.whenReady().then(() => wait(600).then(run).catch((err) => {
  console.error('SMOKE ERROR', err);
  app.exit(2);
}));
