# Reproducing the phase-1b checks

Two traps cost the builder time. Both are environmental, neither is obvious, and each silently produces a *wrong-looking pass or fail* rather than an error. Read this before re-running.

## Trap 1 — the proxy target is baked at BUILD time, not start time

`next.config.mjs` puts `FORGE_CONTROL_URL` into a `rewrites()` destination, which Next serialises into `.next/routes-manifest.json` during `next build`. Setting the variable only on `next start` does nothing: the worktree UI will happily serve your new client code against **production :7700**, whose payload has no `settled` / `ended_at` fields — so `runElapsedMs` sees `settled: undefined`, takes the live branch, and every settled row ticks. That looks exactly like the bug you are trying to fix.

The first frozen-dom run failed this way, with 16 "settled" cells drifting 6s per sample. The fix is to pass the variable to the **build**:

```bash
cd forge-control-web
FORGE_CONTROL_URL=http://127.0.0.1:7798 pnpm build
grep -o '127.0.0.1:77[0-9][0-9]' .next/routes-manifest.json | sort -u   # must print 127.0.0.1:7798
```

Confirm the wire shape before trusting any DOM result:

```bash
curl -s -H "Cookie: authjs.session-token=$(cat /tmp/session-cookie.txt)" \
  http://127.0.0.1:7799/api/proxy/agents | python3 -c "
import json,sys; d=json.load(sys.stdin)
a=[x for x in d['agents'] if x['status']=='completed'][0]
print('settled key present:', 'settled' in a, '| settled:', a.get('settled'))"
# settled key present: True | settled: True
```

*(This is a property of the pre-existing config, not of anything phase 1b changed. Phase 5 deploys client and server together, so production never sees the mismatched pairing.)*

## Trap 2 — /desktop is behind GitHub OAuth

`middleware.ts` redirects anything unauthenticated to `/signin`, and GitHub OAuth cannot be driven headlessly. Rather than weaken the middleware for a screenshot, mint a real next-auth session cookie with the production `AUTH_SECRET`:

```bash
cd forge-control-web
cat > mint-cookie.mjs <<'EOF'
import { encode } from "next-auth/jwt";
const name = "authjs.session-token";
console.log(await encode({
  token: { name: "frozen-dom check", email: "check@localhost", sub: "check" },
  secret: process.env.AUTH_SECRET, salt: name, maxAge: 60 * 30,
}));
EOF
set -a; . /opt/forge-ai-os/forge-control-web/.env.local; set +a
node ./mint-cookie.mjs > /tmp/session-cookie.txt && rm mint-cookie.mjs
```

The script must run from inside `forge-control-web` — `next-auth` resolves from that repo's `node_modules`. Cookie lifetime is 30 minutes; re-mint if `frozen-dom.cjs` reports a redirect to `/signin`.

## Full sequence

```bash
cd <worktree>
set -a; . /opt/ai-os/.secrets/forge-control.env; set +a

# terminal A — patched API on :7798 (round-101 harness; NEVER boot src/index.ts)
cd forge-control && ./node_modules/.bin/tsx ../scripts/checks/serve-agents-7798.ts

# unit check (no server needed)
cd forge-control && ./node_modules/.bin/tsx ../scripts/checks/check-duration.ts

# terminal B — worktree web on :7799, built against the PATCHED api
cd forge-control-web
FORGE_CONTROL_URL=http://127.0.0.1:7798 pnpm build
set -a; . /opt/forge-ai-os/forge-control-web/.env.local; set +a
AUTH_URL=http://127.0.0.1:7799 FORGE_CONTROL_URL=http://127.0.0.1:7798 \
  pnpm exec next start -p 7799

# DOM proof + screenshots (takes ~30s: 3 samples across 12s, plus settle)
cd <worktree>
FORGE_SESSION_COOKIE="$(cat /tmp/session-cookie.txt)" node scripts/checks/frozen-dom.cjs
```

## Reading frozen-dom's output

- It classifies each duration cell by the `title` attribute the render itself sets: `total run time` → settled top-level, `total subagent run time` → done sub-agent, `running for this long` → live.
- It asserts every settled cell is byte-identical across 3 samples spanning 12s (≥3 poll cycles at `refetchInterval: 4_000`, ≥12 clock ticks at 1s).
- It also asserts at least one **live** duration DID advance. Without that counter-check a hung page, a stalled poll, or a crashed React tree would all "pass".
- `found: 0 settled-in-ACTIVE` is normal — settled runs live in the RECENT section. The check fails only if *neither* section has one.
- Sub-agent rows come and go with whatever is running; if a sample finds none, it fails loudly rather than passing vacuously. Ground-truth fixtures if the panel is quiet: run `3853c154-e07b-4378-9313-2b34f4a33342` carries 2 done Explore sub-agents ("Recon agents API and runs schema", "Recon chat Bash block rendering").
- Playwright is loaded by absolute path from `/opt/hermes-workspace/node_modules` (NF4 — not a dependency of either repo). That install wants browser build 1223 and the shared cache only has 1234, so the script resolves whatever chromium is actually present; it prints the path it chose.
