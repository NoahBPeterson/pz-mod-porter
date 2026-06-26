# PZ Mod Porter — Web

Vite + React frontend for the Build 41 → 42 converter. Runs **100% in the browser**:
drop a mod `.zip` or folder, get an honest results dashboard, download the converted `.zip`.

It imports the conversion engine directly from the sibling `../dist` build, so the web app,
the CLI, and the test suite all share one source of truth.

## Develop
```bash
cd ..        # converter root
npm run build   # build the engine -> ../dist  (required before running the web app)
cd web
npm install
npm run dev
```

## Build for production
```bash
npm run build   # -> web/dist (static, host anywhere)
npm run preview
```

> The web app depends on `../dist`. Re-run `npm run build` in the converter root
> whenever the engine changes.
