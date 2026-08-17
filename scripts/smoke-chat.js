// Headless smoke test for ```chat blocks.
// Run: xvfb-run -a npx electron --no-sandbox scripts/smoke-chat.js [server-url]
//
// Part 1 (no network): pushes a slide holding a chat block to an audience-role
// window and asserts the conversation renders as bubbles, reveals one message
// per step, and picks up a transcript mirrored from the presenter.
//
// Part 2 (network, skipped if the server is unreachable): points the app at a
// real OpenAI-compatible server, inserts a chat block into the editor, clicks
// "Ask the model" and asserts a reply streams into the bubble.

const path = require('path');
const os = require('os');
const { app, BrowserWindow } = require('electron');

// Run against a throwaway profile: no leftover tabs or crash-recovery from an
// earlier run, and the real Legilo settings stay untouched.
app.setPath('userData', path.join(os.tmpdir(), `legilo-smoke-chat-${process.pid}`));

require(path.join(process.cwd(), 'main.js')); // boots the editor window + IPC

const SERVER = process.argv.find((a) => /^https?:\/\//.test(a)) || 'http://localhost:11434/v1';

const CHAT_DOC = [
  '# Ask the AI',
  '',
  '```chat',
  '@title: Biology helpdesk',
  '@system: Answer in one short sentence.',
  '',
  'me: What is photosynthesis?',
  'ai: Plants turn sunlight into sugar.',
  'me: Why are leaves green?',
  'ai: ?',
  '```',
].join('\n');

function state(extra) {
  return Object.assign({
    slideText: CHAT_DOC,
    slideIndex: 0,
    slideCount: 1,
    revealStep: 0,
    theme: 'light',
    previewStyle: 'github',
    customCss: '',
    docDir: null,
    blackout: 'off',
    spotlight: false,
    spotlightPos: { x: 0.5, y: 0.5 },
    strokes: [],
    chats: null,
  }, extra);
}

const READ = `(() => {
  const block = document.querySelector('#slide .chat-block');
  const msgs = [...document.querySelectorAll('#slide .chat-msg')];
  return {
    hasBlock: !!block,
    title: block?.querySelector('.chat-head')?.textContent || '',
    count: msgs.length,
    shown: msgs.map((m) => m.classList.contains('shown')),
    sides: msgs.map((m) => (m.classList.contains('chat-you') ? 'you' : 'ai')),
    texts: msgs.map((m) => m.querySelector('.chat-bubble').textContent.trim()),
    hasInput: !!block?.querySelector('.chat-input'), // must be absent on the projector
    directives: document.getElementById('slide').textContent.includes('@system'),
  };
})()`;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// The key the editor window puts on a mirrored transcript: djb2 over the fence
// body, trailing whitespace stripped (see chatKeysIn in src/renderer.js).
function presenterKey(doc) {
  const lines = doc.split('\n');
  const start = lines.findIndex((l) => /^\s*```\s*chat\s*$/.test(l));
  const end = lines.findIndex((l, i) => i > start && /^\s*```\s*$/.test(l));
  const src = lines.slice(start + 1, end).join('\n').replace(/\s+$/, '');
  let h = 5381;
  for (let i = 0; i < src.length; i++) h = ((h * 33) ^ src.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

async function audienceChecks(results) {
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

  w.webContents.send('audience:state', state({ revealStep: 0 }));
  await wait(300);
  results.step0 = await w.webContents.executeJavaScript(READ);

  w.webContents.send('audience:state', state({ revealStep: 1 }));
  await wait(300);
  results.step1 = await w.webContents.executeJavaScript(READ);

  w.webContents.send('audience:state', state({ revealStep: 3 }));
  await wait(300);
  results.step3 = await w.webContents.executeJavaScript(READ);

  // The presenter's window answered the live turn: the transcript is mirrored
  // over the same channel, keyed by the block's source. The key here is derived
  // the way the *presenter* derives it — from the raw Markdown — so this fails
  // if the two sides ever disagree and the projector stops picking answers up.
  const key = presenterKey(CHAT_DOC);
  results.keysAgree = key === await w.webContents.executeJavaScript(
    `document.querySelector('#slide .chat-block').dataset.chatKey`);
  const chats = { [key]: { answers: [[3, 'Because of chlorophyll.']], extra: [], pending: null, error: null } };
  w.webContents.send('audience:state', state({ revealStep: 3, chats }));
  await wait(300);
  results.mirrored = await w.webContents.executeJavaScript(READ);

  w.destroy();
}

async function liveChecks(results) {
  const win = BrowserWindow.getAllWindows().find((b) => !b.isDestroyed());
  if (!win) throw new Error('no editor window');
  await wait(500);

  await win.webContents.executeJavaScript(
    `window.legilo.setPref('chatBaseUrl', ${JSON.stringify(SERVER)}), true`);
  await wait(200);
  results.models = await win.webContents.executeJavaScript('window.legilo.chatModels()');
  if (!results.models.ok) return; // no server on this machine: part 2 is skipped

  win.webContents.send('menu', 'insert:chat'); // Insert → Chat Conversation
  await wait(600);

  results.editor = await win.webContents.executeJavaScript(`(() => {
    const block = document.querySelector('#preview .chat-block');
    return {
      hasBlock: !!block,
      msgs: block ? block.querySelectorAll('.chat-msg').length : 0,
      hasInput: !!block?.querySelector('.chat-input'),
      askable: !!block?.querySelector('.chat-ask'),
    };
  })()`);

  // Watch the raw IPC stream alongside the DOM, so a failure says whether the
  // server or the rendering is at fault.
  await win.webContents.executeJavaScript(`(() => {
    window.__chat = { chunks: 0, done: 0, err: null, text: '' };
    window.legilo.onChatChunk((m) => { window.__chat.chunks++; window.__chat.text += m.text; });
    window.legilo.onChatDone(() => { window.__chat.done++; });
    window.legilo.onChatError((m) => { window.__chat.err = m.message; });
    return true;
  })()`);

  await win.webContents.executeJavaScript(
    `document.querySelector('#preview .chat-ask').click(), true`);
  await wait(400);
  results.thinking = await win.webContents.executeJavaScript(
    `!!document.querySelector('#preview .chat-bubble.thinking')`);

  // Give the model up to 90s, and let the stream settle: the answer is complete
  // once the bubble stops growing.
  let stable = 0;
  for (let i = 0; i < 90; i++) {
    await wait(1000);
    const snap = await win.webContents.executeJavaScript(`(() => {
      const block = document.querySelector('#preview .chat-block');
      const last = [...block.querySelectorAll('.chat-msg')].pop();
      const err = block.querySelector('.chat-error');
      return {
        text: last?.querySelector('.chat-bubble').textContent.trim() || '',
        error: err && !err.hidden ? err.textContent : '',
        ipc: { ...window.__chat, text: window.__chat.text.slice(0, 60) },
      };
    })()`);
    stable = snap.text && snap.text === results.reply?.text ? stable + 1 : 0;
    results.reply = snap;
    if (snap.error || stable >= 2) break;
  }
}

// Presenting the real editor: each arrow press must uncover exactly one more
// message, and the slide must not advance while the conversation still has
// something to say.
async function stepChecks(results) {
  const win = BrowserWindow.getAllWindows().find((b) => !b.isDestroyed());
  win.webContents.send('menu', 'new');
  await wait(300);
  win.webContents.send('menu', 'insert:chat');
  await wait(500);
  win.webContents.send('menu', 'presenter');
  await wait(600);

  const shown = async () => win.webContents.executeJavaScript(
    `[...document.querySelectorAll('#slide .chat-msg')].filter((m) => m.classList.contains('shown')).length`);
  results.steps = [await shown()];
  for (let i = 0; i < 4; i++) {
    await win.webContents.executeJavaScript(
      `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })), true`);
    await wait(250);
    results.steps.push(await shown());
  }
  results.slideCounter = await win.webContents.executeJavaScript(
    `document.getElementById('slide-counter').textContent`);
}

async function run() {
  const results = {};
  await audienceChecks(results);
  await liveChecks(results);
  await stepChecks(results);

  const a = results.step0;
  const structural =
    a.hasBlock && a.title === 'Biology helpdesk' && !a.directives && !a.hasInput &&
    a.count === 4 &&
    a.sides.join() === 'you,ai,you,ai' &&
    a.texts[0] === 'What is photosynthesis?' &&
    // one message per reveal stop: 1 shown at step 0, 2 at step 1, all at step 3
    a.shown.filter(Boolean).length === 1 &&
    results.step1.shown.filter(Boolean).length === 2 &&
    results.step3.shown.filter(Boolean).length === 4 &&
    results.mirrored.texts[3] === 'Because of chlorophyll.' &&
    results.keysAgree;

  // 1 message on arrival, one more per press, and the 4th press is still the
  // same (single) slide rather than a jump.
  const stepping = results.steps.join() === '1,2,3,4,4' && results.slideCounter === '1 / 1';

  const liveSkipped = !results.models?.ok;
  const live = liveSkipped || (
    results.editor?.hasBlock && results.editor.hasInput && results.editor.askable &&
    !results.reply?.error && (results.reply?.text || '').length > 20
  );

  console.log('SMOKE RESULTS:', JSON.stringify(results, null, 2));
  if (liveSkipped) console.log(`(live model checks skipped: ${SERVER} unreachable)`);
  const ok = structural && live && stepping;
  console.log(ok ? 'SMOKE PASS ✅' : 'SMOKE FAIL ❌');
  app.exit(ok ? 0 : 1);
}

app.whenReady().then(() => wait(800).then(run).catch((err) => {
  console.error('SMOKE ERROR', err);
  app.exit(2);
}));
