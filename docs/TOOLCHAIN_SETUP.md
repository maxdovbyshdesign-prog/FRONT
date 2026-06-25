# FRONTIER PLANET Toolchain Setup

## Baseline

Use Node.js 22 LTS for local verification.

Verified during Pass 1 with:

- Node.js `v22.23.1`
- npm `10.9.8`
- Windows PowerShell using `npm.cmd`

Do not standardize this project on Node 24/npm 11 until it has been separately verified. A previous local attempt with Node `v24.16.0` and npm `11.13.0` failed during install with npm's internal `Exit handler never called!` error.

## Windows Notes

PowerShell may block the `npm.ps1` shim with an execution-policy error. Use `npm.cmd` instead:

```powershell
npm.cmd ci
npm.cmd run build
npm.cmd run lint
npm.cmd run dev
```

The dev server is configured by `package.json` to run Vite on port 3000:

```text
http://localhost:3000/
```

## Clean Install

Because `package-lock.json` exists, prefer `npm ci` over `npm install` for verification passes. This recreates `node_modules` from the lockfile without upgrading dependencies.

```powershell
npm.cmd ci --no-audit --no-fund
```

Do not run:

```powershell
npm audit fix
```

Do not upgrade dependencies as part of setup verification.

## Verified Commands

These commands passed in Pass 1 after recovering the dependency tree:

```powershell
npm.cmd ci --no-audit --no-fund
npm.cmd run build
npm.cmd run lint
npm.cmd run dev
```

Key observed output:

- `npm ci`: `added 393 packages in 12m`
- `npm run build`: `vite v6.4.3 building for production...`, `3208 modules transformed`, `built in 39.85s`
- `npm run lint`: `tsc --noEmit`, no TypeScript errors
- `npm run dev`: `VITE v6.4.3 ready`, `Local: http://localhost:3000/`

The build currently emits a Vite chunk-size warning for the main JavaScript bundle. That warning does not block Pass 1 toolchain verification.

## Recovery Checklist

If local dependencies are corrupted:

1. Confirm `package-lock.json` exists.
2. Remove or let `npm ci` replace `node_modules`.
3. Use Node.js 22 LTS.
4. Run `npm.cmd ci --no-audit --no-fund`.
5. Run `npm.cmd run build`.
6. Run `npm.cmd run lint`.
7. Run `npm.cmd run dev` and confirm Vite reports `http://localhost:3000/`.

