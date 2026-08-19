# Self-hosted webfonts — provenance and licences

The three `.woff2` files in this directory are served from this app's own origin
by `app/globals.css`. Before 2026-08-19 they arrived from `fonts.googleapis.com`
over two render-blocking `<link>`s in `app/layout.tsx`; those links are gone.

**Every file here is byte-identical to what Google served for the exact URL
`layout.tsx` used to link.** Nothing was re-subsetted, re-encoded or rebuilt
locally — self-hosting changes *where the bytes come from*, not the bytes.

## What is here

| file | family | source URL (from the `@font-face` block of the CSS response) | sha256 | bytes |
|---|---|---|---|---|
| `inter-variable-latin.woff2` | Inter, variable `wght 100..900`, **latin subset** | `https://fonts.gstatic.com/s/inter/v20/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa1ZL7.woff2` | `3100e775e8616cd2611beecfa23a4263d7037586789b43f035236a2e6fbd4c62` | 48256 |
| `jetbrains-mono-variable-latin.woff2` | JetBrains Mono, variable `wght 100..800`, **latin subset** | `https://fonts.gstatic.com/s/jetbrainsmono/v24/tDbV2o-flEEny0FZhsfKu5WU4xD7OwE.woff2` | `18be452724bfdc236c074ca94a249a7f41a86752c7d04ab258ce9ed5651f6a7e` | 40404 |
| `material-symbols-outlined.woff2` | Material Symbols Outlined, **static instance** at `opsz 20, wght 200, FILL 0, GRAD 0` | `https://fonts.gstatic.com/s/materialsymbolsoutlined/v367/kJF1BvYX7BgnkSrUwT8OhrdQw4oELdPIeeII9v6oDMzByHX9rA6RzaxHMPdY43zj-jCxv3fzvRNU22ZXGJpEpjC_1p-p_4MrImHCIJIZrDAvHOej.woff2` | `513215b99100b0bfc7375711e13b5b1c4c3da9cd81c94bfdc864977ff1496933` | 359460 |

Two details a future reader will otherwise re-derive the hard way:

- **The latin subset is one file per text family, not five.** `globals.css` asks
  Inter for 400/450/500/600 and JetBrains Mono for 400/500; a variable face
  covers every one of them from a single request. That is also why
  `document.fonts.size` drops from 45 (Google ships many `unicode-range`
  subsets) to a much smaller number — do not assert a specific value on it.
- **The Material Symbols file is a STATIC instance, not a variable face.**
  Requesting the pinned axes `opsz,wght,FILL,GRAD@20,200,0,0` — which is what
  `layout.tsx` linked — makes Google serve one instantiated weight. Its
  `@font-face` therefore declares `font-weight: 200` and carries **no**
  `unicode-range`: the icon glyphs live in the Private Use Area and are reached
  by ligature, so restricting the range would break the substitution and put the
  literal words (`description`, `open_in_new`) straight back on screen.

## Fetching them again

`-4` is load-bearing on this host: `fonts.googleapis.com` publishes an AAAA
record and this box has no working IPv6 egress, so a bare `curl` can stall for
20 s and return `000`. A modern browser User-Agent is also required, or Google
serves a legacy (non-woff2) format.

```bash
UA='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
curl -4 -sS -A "$UA" 'https://fonts.googleapis.com/css2?family=Inter:wght@100..900&display=swap'
# → take the src: url(...) from the `/* latin */` @font-face block
```

## Licences

**Inter** — SIL Open Font License 1.1. Copyright (c) 2016 The Inter Project
Authors (<https://github.com/rsms/inter>).
<https://openfontlicense.org/open-font-license-official-text/>

**JetBrains Mono** — SIL Open Font License 1.1. Copyright (c) 2020 The JetBrains
Mono Project Authors (<https://github.com/JetBrains/JetBrainsMono>).

**Material Symbols Outlined** — Apache License 2.0. Copyright Google LLC
(<https://github.com/google/material-design-icons>).
<https://www.apache.org/licenses/LICENSE-2.0>

All three permit redistribution, including bundled and self-hosted as here. The
OFL additionally forbids selling the fonts by themselves and requires that any
*modified* version be renamed — neither applies: these files are unmodified and
are shipped as part of an application, not sold as fonts.
