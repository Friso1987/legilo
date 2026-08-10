<div align="center">

<img src="logo/icon-256.png" width="96" alt="Legilo logo" />

# Legilo

**Markdown for teachers. Prepare a lesson, teach it live, hand it out.**

Legilo is a split-view Markdown editor built for the classroom. One plain-text
document becomes your lesson notes, a live slide deck you present on a second
screen, and a print-ready handout — without ever leaving the app or fighting
with slide templates.

![Windows](https://img.shields.io/badge/Windows-supported-0969da)
![macOS](https://img.shields.io/badge/macOS-supported-0969da)
![Linux](https://img.shields.io/badge/Linux-supported-0969da)
![License: MIT](https://img.shields.io/badge/license-MIT-green)

<img src="docs/screenshot-split.png" width="850" alt="Legilo split view: Markdown on the left, live preview on the right" />

</div>

## Why teachers like it

- **You write, not fiddle.** Type in plain Markdown; there are no text boxes to
  drag, no theme to wrestle. Headings, bullets, tables and images just work.
- **One file, three jobs.** The same document is your lesson prep, your
  projected slides, and the handout you print or e-mail afterwards.
- **You stay in control during the lesson.** Present on the projector while your
  own screen keeps the editor — so you can fix a typo, jump to a question, or
  add an example on the fly, and the class sees it instantly.

---

## ✍️ Prepare the lesson

- **Split view** — editor on the left, live preview on the right, with
  synchronized scrolling and a draggable divider
- **Tabs** that reopen exactly where you left off, with unsaved-changes guards
- **Insert & right-click menus** — images via a file picker, tables, code
  blocks, task lists, footnotes, links… no syntax to memorize
- **Spellcheck** with suggestions, straight from your OS dictionary
- **Everything Markdown**: GitHub-flavored tables, task lists, footnotes and
  fenced code with syntax highlighting
- **Maths with KaTeX** — inline `$E = mc^2$` and display `$$…$$` blocks, ideal
  for science and maths lessons
- **Diagrams** — fenced ` ```mermaid ` or ` ```d2 ` blocks become flowcharts,
  timelines, cycles and concept maps, live in the preview and on your slides
- **Video** — a bare YouTube or Vimeo link on its own line becomes an embedded
  player; local `.mp4`/`.webm` clips work too
- Opening an **HTML file converts it to Markdown** automatically, so old
  materials come across cleanly

Turn any document into slides by starting a new slide with a `---` line — the
**Slides** preview layout lets you flip through the deck while you write.

---

## 🎤 Teach it

Press **F5** to present fullscreen, or **Shift+F5** to present on a second
screen. Navigate with the arrow keys, space, a clicker, or the on-screen
controls.

### Second screen, and you keep editing

**Shift+F5** puts the slides fullscreen on the projector and turns your own
screen into a **presenter console**: the current slide, the next slide, a timer
and wall clock, and your private notes — all while the editor stays open
beside it. Change a word and the class sees it the same second. This is the
core feature for live teaching.

- Navigate with **PageUp/PageDown** (works with most presentation remotes) or
  the console's ‹ › buttons; arrow keys and space work too when you're not
  typing in the editor.

### Bring the class along, one point at a time

Instead of dumping a whole slide at once, reveal it step by step. A line of
just `. . .` (three dots) is a **pause** — everything after it stays hidden
until your next click, then fades in:

```markdown
## Photosynthesis

- Light + CO₂

. . .

- → glucose + O₂

. . .

> Where does this happen?
```

### Speaker notes, only for you

Put reminders in `<!-- note: … -->`. They appear on your console, **never** on
the projector:

```markdown
## The French Revolution

- 1789: storming of the Bastille

<!-- note: ask who's read the chapter; keep this slide under 3 minutes -->
```

### Annotate and focus attention

- **Draw on the slide** — a digital pen just works (its eraser end erases),
  pressure-sensitive, with a mouse fallback (**P**). Rough strokes snap into
  **perfect lines and circles**, and each slide keeps its ink. On the second
  screen, press **A** to pop the slide up on your screen so you can draw on it —
  the class sees every stroke live.
- **Black out** the screen with **B** (**W** for white) to pull all eyes back to
  you; press again to bring the slide back.
- **Spotlight** with **S** — dim everything but a circle that follows your
  pointer, to focus on one figure or line.
- Overfull slides **auto-shrink to fit** and warn you, so nothing ever runs off
  the edge mid-lesson.

<div align="center">
<img src="docs/screenshot-presenter.png" width="850" alt="Presenter mode: fullscreen slide with auto-fit warning" />
</div>

---

## 📄 Hand it out

- **Page view** — Word-like A4 / US Letter sheets that show exactly how the
  document fills printed pages while you type; `\pagebreak` forces a new page
- **Print** (`Ctrl+P`), **print preview**, and **Export to PDF / HTML** — all
  styled, with maths, code highlighting and diagrams
- **Export to Word** (`.docx`) — a flowing, fully editable handout that keeps
  your preview style, tables, lists, code and page breaks; diagrams and maths
  come across as crisp images
- **Export to PowerPoint** (`.pptx`) — one native slide per `---`, laid out just
  like presenter mode, so colleagues can open your deck in PowerPoint. YouTube
  links become native online-video objects and local `.mp4` files are embedded
  as playable media

---

## 🎨 Make it yours

- **Light & dark themes** (`Ctrl+Shift+D`) — diagrams re-render to match
- **Seven preview styles**: GitHub, Book (serif, print-friendly), Minimal,
  Academic (auto-numbered sections), Slate, Typewriter, and Newspaper — exports
  and PDFs follow the active style
- **Bring your own CSS** — load any stylesheet targeting `.markdown-body`
- Window size, theme, layout and open tabs are remembered between sessions

<div align="center">
<img src="docs/screenshot-slides-dark.png" width="850" alt="Dark theme with the slides preview layout" />
</div>

---

## Install

Grab the latest installer from the [Releases](../../releases) page:

| OS | File |
| --- | --- |
| Windows | `Legilo Setup <version>.exe` (also available in the Microsoft Store) |
| macOS | `Legilo-<version>.dmg` — unsigned: right-click → Open the first time |
| Linux | `Legilo-<version>.AppImage` or `.deb` |

## Build from source

```bash
git clone https://github.com/Friso1987/legilo.git
cd legilo
npm install
npm start        # development mode
npm run dist     # build installers for your OS
```

<details>
<summary>Linux dev note: Chromium sandbox error on <code>npm start</code></summary>

If Electron aborts with `chrome-sandbox is owned by root and has mode 4755`,
either run `npm run start:linux` (dev-only, unsandboxed) or fix the helper
once per install:

```bash
sudo chown root:root node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
```

</details>

Releases are built for all three platforms by GitHub Actions: push a tag like
`v0.5.0` (`npm version 0.5.0 && git push --follow-tags`) and the installers
appear on a draft GitHub release.

### Project layout

```
main.js            # Electron main process: windows, second-screen window, menus, dialogs
preload.js         # contextBridge API (contextIsolation + sandbox on)
src/renderer.js    # editor, preview, presenter, dual-view sync, pagination (bundled by esbuild)
renderer/          # app shell, styles, generated bundles
```

## Keyboard shortcuts

| | |
| --- | --- |
| `Ctrl+N` / `Ctrl+W` / `Ctrl+Tab` | New / close / switch tab |
| `Ctrl+O` / `Ctrl+S` / `Ctrl+Shift+S` | Open / Save / Save As |
| `Ctrl+B` / `Ctrl+I` / `Ctrl+K` | Bold / italic / link |
| `Ctrl+F` / `Ctrl+H` | Find / replace |
| `Ctrl+P` / `Ctrl+E` | Print / export HTML |
| `Ctrl+1` `2` `3` | Split / editor / preview |
| `Ctrl+Shift+P` | Preview layout: flow / page / slides |
| `Ctrl+Shift+D` | Dark theme |
| `F5` / `Shift+F5` | Present / present on a second screen |
| `→` `←` `Space` | Next / previous (reveals `. . .` steps too) |
| `PageDown` / `PageUp` | Next / previous (presentation remotes) |
| `P` / `E` / `C` / `X` | While presenting: pen / eraser / pen colour / clear ink |
| `B` / `W` / `S` | While presenting: black out / white out / spotlight |
| `A` | Second-screen mode: pop up the slide to draw on it |

## License

[MIT](LICENSE)
