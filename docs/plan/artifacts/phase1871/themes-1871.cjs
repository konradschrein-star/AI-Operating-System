const fs=require("node:fs"),path=require("node:path");
const {chromium}=require("/opt/hermes-workspace/node_modules/playwright");
const cache="/root/.cache/ms-playwright";
const exe=fs.readdirSync(cache).filter(d=>d.startsWith("chromium")).map(d=>d.startsWith("chromium_headless_shell-")?path.join(cache,d,"chrome-headless-shell-linux64","chrome-headless-shell"):path.join(cache,d,"chrome-linux64","chrome")).filter(p=>fs.existsSync(p))[0];
const OUT="/opt/ai-os/workspace/projects/8ea0cc08-28d9-4301-9f28-c98e1c5d6838/docs/plan/artifacts/phase1871";
(async()=>{
const b=await chromium.launch({executablePath:exe,args:["--no-sandbox","--disable-dev-shm-usage"]});
const ctx=await b.newContext({viewport:{width:1600,height:1000}});
await ctx.addCookies([{name:"authjs.session-token",value:fs.readFileSync("/tmp/session-cookie-1871.txt","utf8").trim(),domain:"127.0.0.1",path:"/",httpOnly:true,sameSite:"Lax"}]);
const p=await ctx.newPage();
await p.goto("http://127.0.0.1:7780/desktop",{waitUntil:"domcontentloaded"});
await p.waitForTimeout(5000);
await p.getByText("CHAT",{exact:true}).first().click();
await p.waitForSelector(".chat-row",{timeout:30000});
await p.evaluate(id=>document.querySelector(`[data-chat-id="${id}"]`)?.click(),"bfd1283a-b71b-4f35-b577-7d09aad803f2");
await p.waitForTimeout(7000);
for (const theme of ["dark","light"]) {
  await p.evaluate(t=>{document.documentElement.setAttribute("data-theme",t);},theme);
  await p.waitForTimeout(1200);
  await p.screenshot({path:path.join(OUT,`theme-${theme}.png`)});
  const probe = await p.evaluate(()=>{
    const pick=(sel)=>{const e=document.querySelector(sel); if(!e) return null; const cs=getComputedStyle(e); return {color:cs.color, bg:cs.backgroundColor, border:cs.borderLeftColor};};
    const lum=(rgb)=>{const m=/rgba?\((\d+), ?(\d+), ?(\d+)/.exec(rgb||""); if(!m) return null; const [r,g,bl]=[+m[1],+m[2],+m[3]].map(v=>{v/=255; return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4);}); return 0.2126*r+0.7152*g+0.0722*bl;};
    const ratio=(a,b)=>{const la=lum(a),lb=lum(b); if(la==null||lb==null) return null; const [hi,lo]=la>lb?[la,lb]:[lb,la]; return Math.round(((hi+0.05)/(lo+0.05))*100)/100;};
    const bodyBg=getComputedStyle(document.body).backgroundColor;
    const out={theme:document.documentElement.getAttribute("data-theme"), bodyBg};
    for (const [k,sel] of Object.entries({
      commsToggle:"[data-comms-toggle]",
      projectChoice:"[data-project-choice]",
      phaseHeader:"[data-plan-phase-header]",
      taskChip:"[data-plan-task]",
      tokensCell:"[data-tokens-cell]",
      modelCell:"[data-model-cell]",
    })) { const v=pick(sel); out[k]= v? {...v, contrastOnBody: ratio(v.color, v.bg==="rgba(0, 0, 0, 0)"?bodyBg:v.bg)} : "absent"; }
    return out;
  });
  console.log(JSON.stringify(probe,null,1));
}
await b.close();
})();
