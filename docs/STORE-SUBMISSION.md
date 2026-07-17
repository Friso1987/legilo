# Publishing an update to the Microsoft Store

How to ship a new Legilo version (e.g. 0.3.0) to the Microsoft Store, where
0.2.0 is already published under the identity `Friso.Legilo`.

## 1. Build the .appx

The version in `package.json` must be higher than the one in the Store
(the Store compares `0.3.0.0` > `0.2.0.0`).

**Option A — GitHub Actions (recommended, no Windows machine needed):**

```bash
git tag v0.3.0
git push --follow-tags
```

The `Build & Release` workflow builds `Legilo-0.3.0.appx` on a Windows
runner and attaches it to a draft GitHub release (also downloadable from
the workflow run's `legilo-windows-latest` artifact).

**Option B — locally on Windows:**

```powershell
npm ci
npm run dist:store    # → dist/Legilo-0.3.0.appx
```

The package does **not** need to be code-signed — the Store signs it after
certification. The identity fields (`identityName: Friso.Legilo`,
`publisher: CN=3EF51276-F72D-4BBB-B7EF-5A76563CC427`) are already configured
in `package.json` and must keep matching the values in Partner Center.

## 2. Create the submission in Partner Center

1. Sign in at <https://partner.microsoft.com/dashboard> and open
   **Apps and games → Legilo**.
2. Click **Start update** on the published submission (this clones the
   0.2.0 submission — listing, screenshots, and properties carry over).
3. Open the **Packages** section, delete/replace nothing yet — just
   **upload `Legilo-0.3.0.appx`** and wait for the automatic package
   validation to pass. Keep the 0.2.0 package listed or remove it; either
   is fine (the Store always serves the highest version per architecture).
4. In **Store listings → What's new in this version**, describe the update,
   e.g.:

   > • Mermaid and D2 diagrams render straight from fenced code blocks —
   >   in the preview, on slides, in print and PDF
   > • Draw on slides while presenting with a digital pen or mouse —
   >   pressure-sensitive ink, eraser, and automatic snapping to perfect
   >   lines and circles
   > • Embed YouTube/Vimeo videos with a bare link on its own line
   > • Four new preview styles: Academic, Slate, Typewriter, Newspaper
5. Optionally refresh the screenshots (new poster art scripts live in
   `scripts/gen-appx-tiles.py` / `scripts/gen-poster-art.py`).
6. Click **Submit for certification**. Certification usually takes
   1–3 business days; you'll get an email when it goes live.

## Troubleshooting

- **"Package acceptance validation error: version must be greater"** — bump
  `version` in `package.json`, rebuild, re-upload.
- **Identity mismatch** — the `appx.identityName` / `publisher` in
  `package.json` must equal *Product identity* under Partner Center →
  Product management → Product identity.
- **10.1.1.11 policy (Store tile assets)** — branded tiles are already
  shipped from `build/appx/` since 0.2.0; keep them when changing icons.
