# PZ Mod Porter · Build 41 → Build 42

Convert **Project Zomboid** Build 41 workshop mods to Build 42 — entirely in your browser.

### ▶ Live app: https://noahbpeterson.github.io/pz-mod-porter/

Drop a mod `.zip` or folder, get an honest results dashboard, and download a Build 42 `.zip`.
Nothing is uploaded — the conversion runs 100% client-side, so your files never leave your machine.

## What it converts

- **Scripts** — `recipe` → `craftRecipe`, item `Type` → `ItemType`, ingredient/flag/tag mappings, a generated `Recipes.json`, and `timedAction` inference.
- **Lua** — removed events & `require`s commented + annotated, verified global re-roots, `recipecode` callback rewrites, and `OnGiveXP` → `xpAward`/shim recovery.
- **Maps** — a from-scratch port of the engine's own re-grid converter: B41 cells (300×300 squares / 10×10 chunks) are losslessly rebuilt on the B42 grid (256×256 / 8×8). Includes a tile drop/rename table (B42 regrows trees procedurally), `spawnpoints.lua` + `worldmap.xml` coordinate reprojection, and own-vs-external tile-pack detection. Runs in a Web Worker with progress + ETA.

Every mod gets an honest verdict — **fully converted**, **minor notes**, **review advised**, or **needs manual porting** — with grouped findings and a per-file red/green diff (images preview inline).

## Develop

```bash
npm install && npm run build   # build the conversion engine -> dist/
cd web
npm install
npm run dev                    # http://localhost:5173
```

The web app imports the engine from `../dist`, so re-run `npm run build` in the root after engine changes.

```bash
cd web && npm run build        # production build -> web/dist/
```

## How it's built

- **Engine** (`src/`) — TypeScript 6, maximal strictness, compiled to `dist/`. AST-based codemods (luaparse for Lua 5.1 / Kahlua); the map format readers/writers were reverse-engineered from the decompiled engine.
- **Web** (`web/`) — Vite + React + TypeScript, JSZip for archives, everything bundled (no CDN runtime deps).
- **Deploy** — GitHub Actions builds the engine then the web app and publishes `web/dist` to GitHub Pages.

---

🤖 Built with [Claude Code](https://claude.com/claude-code)
