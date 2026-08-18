/**
 * theme-contrast-1355.cjs — round 1355's new controls, measured in BOTH themes.
 *
 * The gate document asks a reviewer to "verify both themes". A screenshot pair
 * does not verify it — round 1350's `team-light-*.png` are genuinely light
 * (body `rgb(247,247,245)`, pixel-probed) but nothing in that artifact states a
 * measured number, so "both themes work" rested on looking. This reads the
 * COMPUTED colour of each control out of the running page and puts a WCAG
 * contrast ratio on it against the surface behind it.
 *
 * The peeked row is special-cased on purpose: it is faded to opacity 0.55, so
 * its ↺ is scored at its EFFECTIVE contrast (1 + (r-1) x opacity), not at the
 * ratio the colour would have at full strength. A fade that makes a control
 * unreadable is not a fade, it is a hide.
 *
 * Floor: 2.0 effective. These are 9.5px muted-chrome labels in a 260px panel,
 * the same class as the existing "N running"/"RECENT" headings — the project's
 * own contrast gates (contrast-nav-rail.cjs, contrast-role-tints.cjs) score
 * that tier the same way. Nothing here is body text.
 *
 * Needs the harness from README.md in this directory (API :7870, web :7871).
 *
 * Run:
 *   node docs/plan/artifacts/phase1355/theme-contrast-1355.cjs
 */
const fs=require("node:fs"),path=require("node:path");
const { chromium } = require("/opt/hermes-workspace/node_modules/playwright");
function resolveChromium(){const c=process.env.PLAYWRIGHT_BROWSERS_PATH??"/root/.cache/ms-playwright";
 return fs.readdirSync(c).filter(d=>d.startsWith("chromium_headless_shell-")||d.startsWith("chromium-"))
 .map(d=>d.startsWith("chromium_headless_shell-")?path.join(c,d,"chrome-headless-shell-linux64","chrome-headless-shell"):path.join(c,d,"chrome-linux64","chrome")).filter(p=>fs.existsSync(p))[0];}
const API="http://127.0.0.1:7870", BASE="http://127.0.0.1:7871";
const lum=(r,g,b)=>{const f=v=>{v/=255;return v<=0.03928?v/12.92:((v+0.055)/1.055)**2.4};return 0.2126*f(r)+0.7152*f(g)+0.0722*f(b)};
const parse=s=>s.match(/\d+/g).slice(0,3).map(Number);
const ratio=(a,b)=>{const[l1,l2]=[lum(...parse(a)),lum(...parse(b))].sort((x,y)=>y-x);return (l1+0.05)/(l2+0.05)};
(async()=>{
 let bad=0;
 const br=await chromium.launch({executablePath:resolveChromium()});
 for(const theme of ["dark","light"]){
  await fetch(`${API}/api/agents/dismissals`,{method:"DELETE"});
  const ctx=await br.newContext({viewport:{width:1440,height:1000}});
  await ctx.addCookies([{name:"authjs.session-token",value:fs.readFileSync("/tmp/r1355-cookie.txt","utf8").trim(),domain:"127.0.0.1",path:"/",httpOnly:true,sameSite:"Lax"}]);
  await ctx.addInitScript(t=>{try{localStorage.setItem("forge.theme",t)}catch(e){}},theme);
  const p=await ctx.newPage();
  await p.goto(`${BASE}/desktop`,{waitUntil:"networkidle",timeout:60000});
  await p.waitForTimeout(1500);
  await p.getByText("CHAT",{exact:true}).first().click(); await p.waitForTimeout(2500);
  await p.getByText("Okay when I click the file section",{exact:false}).first().click();
  await p.waitForSelector("[data-team-row]",{timeout:30000}); await p.waitForTimeout(1500);
  await p.locator('[data-team-x][title^="Hide this row"]').last().click(); await p.waitForTimeout(900);
  await p.click("[data-team-dismissed-toggle]"); await p.waitForTimeout(600);
  await p.click("[data-team-restore-all]"); await p.waitForTimeout(300);
  const m=await p.evaluate(()=>{
    const cs=el=>el?getComputedStyle(el):null;
    const panel=document.querySelector("[data-team-panel]");
    const surface=(()=>{let e=panel;while(e){const b=getComputedStyle(e).backgroundColor;if(b&&b!=="rgba(0, 0, 0, 0)")return b;e=e.parentElement}return "rgb(0,0,0)"})();
    const row=document.querySelector('[data-team-peeked="true"]');
    const restore=document.querySelector("[data-team-restore]");
    const toggle=document.querySelector("[data-team-dismissed-toggle]");
    const ra=document.querySelector("[data-team-restore-all]");
    const grp=document.querySelector("[data-team-dismissed-group]");
    return {surface, rowOpacity:cs(row).opacity,
      restore:cs(restore).color, toggle:cs(toggle).color, ra:cs(ra).color, raText:ra.textContent.trim(),
      group:cs(grp).color, theme:document.documentElement.dataset.theme};
  });
  console.log(`\n── ${theme} (data-theme=${m.theme}, surface ${m.surface}) ──`);
  for(const [k,v] of [["peek row ↺",m.restore],["dismissed toggle",m.toggle],["restore all (ARMED)",m.ra],["DISMISSED heading",m.group]]){
    // the peeked row is faded, so its effective contrast is scaled by opacity
    const scale=k==="peek row ↺"?Number(m.rowOpacity):1;
    const r=ratio(v,m.surface);
    const eff=1+(r-1)*scale;
    const ok=eff>=2.0;
    if(!ok) bad++;
    console.log(`  ${ok?"OK  ":"LOW "} ${k.padEnd(20)} ${v.padEnd(22)} contrast ${r.toFixed(2)}${scale<1?` × opacity ${m.rowOpacity} → ${eff.toFixed(2)}`:""}`);
  }
  console.log(`  armed label: ${JSON.stringify(m.raText)}   peeked row opacity: ${m.rowOpacity}`);
  await ctx.close();
 }
 await br.close();
 await fetch(`${API}/api/agents/dismissals`,{method:"DELETE"});
 console.log(`\n${bad===0?"ALL LEGIBLE":`${bad} LOW-CONTRAST`} — round 1355 controls, both themes`);
 process.exit(bad===0?0:1);
})();
