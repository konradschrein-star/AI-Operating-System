# Round 1350 — settings inside the shell: evidence

Every number and screenshot here was produced **inside the worktree**, offline.
No live service was touched, nothing was restarted, `/opt/forge-ai-os` was not
opened. The web app's own routes are behind NextAuth (`middleware.ts` redirects
to `/signin`), so a screenshot of the running site is a deploy-phase job — what
this round could prove instead is the component itself, mounted in a real
Chrome with the app's real `theme.css` + `globals.css`.

## 1. Static checks

| check | command | result |
| --- | --- | --- |
| types | `npx tsc --noEmit` (forge-control-web) | exit 0 |
| build | `npm run build` (forge-control-web) | ✓ compiled, 10/10 static pages, `/settings` 1.54 kB |
| tokens | `grep -n "#[0-9a-fA-F]\{3\}\|rgb(\|rgba(\|hsl(" app/desktop/settings/*.tsx app/settings/page.tsx` | zero hits |
| unit | `../forge-control/node_modules/.bin/tsx --tsconfig ../tsconfig.checks.json ../scripts/checks/check-settings-surface.tsx` | PASS — 38/38 |

## 2. Real browser, both themes

`harness-drive.mjs` (kept here verbatim) bundles `SettingsSurface` with esbuild,
mounts it into a page that inlines `app/theme.css` and `app/globals.css`, and
drives system Chrome through the whole navigation in **both palettes**. Dark is
`:root`; light is `html[data-theme="light"]`, the same switch `applyTheme` sets.

Reproduce (paths are absolute in the script; esbuild comes from tsx's install):

```
esbuild <entry mounting SettingsSurface> --bundle --jsx=automatic \
  --alias:next/link=<a plain <a> stub, no router in a bare page>
node harness-drive.mjs
```

Machine-checked in that run, identical for `dark` and `light`:

| assertion | dark | light |
| --- | --- | --- |
| click ACCOUNTS → `data-settings-section` | `accounts` | `accounts` |
| back button present (`[data-nav-back]`, the exported `BackButton`) | 1 | 1 |
| computed `animation-name` on the body container | `navdrill` | `navdrill` |
| click back → `data-settings-section` | `index` | `index` |
| uncaught page errors | none | none |

The `navdrill` animation name is the point: the drill is the chat surface's
existing keyframes from `app/globals.css`, replayed by a changed React key —
not a second animation, and no animation dependency was added.

### The secrets embed

`SecretsPanel` mounts `app/settings/secrets/page.tsx` (another owner's file,
untouched) and neutralises its page chrome from the outside. Computed styles in
the same run, both themes:

| property | value | meaning |
| --- | --- | --- |
| `min-height` of the embedded page root | `0px` | the `100dvh` viewport claim is gone |
| `padding` | `0px` | no page gutter inside a panel |
| visible `a[href="/settings"]` | 0 | no link that would unmount the OS |
| visible `<h1>` | 0 | no duplicate title above the section header |
| host height | 141 px (vs 620 px viewport) | it is a panel, not a page |

## 3. Screenshots

| file | what it shows |
| --- | --- |
| `shot-dark-index.png` / `shot-light-index.png` | depth 0 — section list + index cards |
| `shot-dark-accounts.png` / `shot-light-accounts.png` | depth 1 — ACCOUNTS, back button, crumb line |
| `shot-dark-secrets.png` / `shot-light-secrets.png` | depth 1 — the embedded secrets page, chrome stripped |

Two things are harness artefacts, not product defects:

* icons render as their glyph names (`account_circle`, `key`, …) because the
  Material Symbols font is loaded by the app's layout, not by this bare page;
* the panels show "Failed to fetch" — there is no `/api/proxy` in a `file://`
  page. That is the components' real error path rendering correctly, which is
  itself worth seeing in both palettes.
