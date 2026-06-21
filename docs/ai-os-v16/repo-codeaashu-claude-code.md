# repo: codeaashu/claude-code

## TL;DR

**SKIP.** This repo is not what its name suggests. It is an archive of allegedly leaked Anthropic Claude Code CLI source (~1,900 files, 512k LoC) published without a license. The README itself states: _"All original source code is the property of Anthropic. This is not an official release and is not licensed for redistribution."_ Using this code in our codebase would be a copyright / TOS violation against Anthropic — the same vendor whose API powers our pool. Hard no on lifting any source. There is also a structural mismatch: the UI is React + **Ink** (terminal renderer), not DOM React, so most components would need a full rewrite regardless of license.

## Repo overview

- **What it is:** Archive of leaked Claude Code CLI source code (terminal app), not a component library.
- **Stack:** Bun + TypeScript (strict) + React + **Ink** (terminal UI, not DOM) + Commander.js + Zod v4 + Anthropic SDK + MCP SDK + OAuth/JWT + OpenTelemetry.
- **Scale:** ~1,900 files, 512k LoC, ~140 Ink components, ~50 slash commands, ~40 tools.
- **Notable dirs:** `src/QueryEngine.ts`, `src/Tool.ts`, `src/commands.ts`, `src/components/{Message,PromptInput,Markdown,HighlightedCode,StructuredDiff}`, `src/coordinator/`, `src/services/`.
- **Provenance:** README claims source leaked via unobfuscated `.map` files on Anthropic's npm registry, 2026-03-31. Repo is archived.

## License

**Unlicensed proprietary.** README explicitly forbids redistribution. Not MIT / Apache / BSD. Lifting any code = copyright infringement + Anthropic TOS exposure. **Do not copy, even "as inspiration with rewriting" — derivative-work risk.**

## Component catalog

| Path                              | Purpose                 | Lift effort | Verdict                      |
| --------------------------------- | ----------------------- | ----------- | ---------------------------- |
| `src/components/Message.tsx`      | Message renderer (Ink)  | L           | Skip — Ink, not DOM; license |
| `src/components/PromptInput/`     | Composer + slash menu   | L           | Skip — Ink keystroke model   |
| `src/components/Markdown.tsx`     | Markdown render (Ink)   | L           | Skip — use `react-markdown`  |
| `src/components/HighlightedCode/` | Code highlighting (Ink) | L           | Skip — use `shiki` / `prism` |
| `src/components/StructuredDiff/`  | Diff view (Ink)         | L           | Skip — out of scope for chat |
| `src/components/Spinner.tsx`      | Loading                 | S           | Skip — trivial to rebuild    |
| `src/commands/` (~50 slash cmds)  | Slash command registry  | M           | Skip — license; shape only   |

Lift effort assumes hypothetical port to DOM React + V2 inline styles. Every component would need full reimplementation because Ink primitives (`<Box>`, `<Text>`, `useInput`) don't exist in DOM React.

## Top 3 copy targets

**None.** Recommended replacements using permissively licensed libraries already in the npm ecosystem:

1. **Markdown + code blocks** → `react-markdown` (MIT) + `shiki` (MIT). Destination: `forge-control-web/app/desktop/chat/MessageMarkdown.tsx` (new).
2. **Slash command menu pattern** → build from scratch using `cmdk` (MIT) styled with V2 tokens. Destination: `forge-control-web/app/desktop/chat/SlashMenu.tsx` (new).
3. **Composer Enter handling + autosize** → write directly, ~40 LoC. Destination: existing `ChatSurface.tsx`.

## What to skip

Everything in the repo. Especially do not copy: `QueryEngine.ts`, tool definitions, slash command implementations, OAuth flow, telemetry, MCP wiring, or component JSX — all carry Anthropic copyright.

## Risks

- **Legal:** Copying ANY portion (including "patterns" that are non-trivial expression) exposes the project to copyright claims from Anthropic.
- **Vendor relationship:** We depend on Anthropic API (Claude pool, Opus 4.7) — incorporating leaked source is a direct TOS breach.
- **Technical:** Ink-based JSX uses terminal-only primitives; no clean port path to our V2 inline-style DOM React even ignoring license.
- **Reputational:** Repo is archived and disputed; any inbound link/PR referencing it is a red flag.

**Action:** Close the tab. Use `react-markdown` + `shiki` + `cmdk` to build the chat surface upgrade from clean-room sources.
