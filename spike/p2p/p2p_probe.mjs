// PHA-4004 spike, end to end in browsers: browser A opens the host page (server in a Worker), browser B opens the
// shipped CS Party client page with the DataChannel shim and joins the host's lobby code. Separate browser
// processes, so the only path between them is WebRTC. The host's logs (server console + stats) are the judge;
// no page calls into B while its engine runs (docs/dev-harness.md).
//
// usage: PW=<playwright-core> CHROME=<chrome-headless-shell> node p2p_probe.mjs <site url> [seconds]
import { createRequire } from "node:module";
import fs from "node:fs";
const { chromium } = createRequire(import.meta.url)(process.env.PW);
const [site, secs = "300"] = process.argv.slice(2);
const shim = fs.readFileSync(new URL("./web/p2p_client.js", import.meta.url), "utf8");
const t0 = Date.now(), stamp = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6);
const launch = () => chromium.launch({
  executablePath: process.env.CHROME,
  args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--autoplay-policy=no-user-gesture-required", "--no-sandbox",
    "--disable-features=WebRtcHideLocalIpsWithMdns"],   // plain host candidates; no mDNS resolver in this container
});

const hostB = await launch();
const host = await hostB.newPage();
host.on("console", (m) => { const t = m.text(); if (!/Server cvar|Unknown command|Could not load model/.test(t)) console.log(`${stamp()} [host] ${t.slice(0, 220)}`); });
host.on("pageerror", (e) => console.log(`${stamp()} [host pageerror] ${e.message}`));
await host.goto(`${site}/host.html?code=SPIKE&args=${encodeURIComponent("+bot_enable 1 +maxplayers 8 +sv_connect_timeout 600 +sv_connect_timeout_ban 0 +map de_dust2")}`);
await host.waitForFunction(() => window.__hostReady === true, null, { timeout: 180000, polling: 2000 });
console.log(`${stamp()} [probe] host server ready`);
await host.evaluate(() => { serverCmd("bot_quota_mode fill"); serverCmd("bot_quota 3"); });

const playerB = await launch();
const pl = await playerB.newPage({ viewport: { width: 960, height: 600 } });
await pl.addInitScript(shim);
pl.on("console", (m) => { const t = m.text(); if (/p2p|watch|consisten|Disconnect|kicked|refused|error/i.test(t) && !/GL Driver/.test(t)) console.log(`${stamp()} [player] ${t.slice(0, 200)}`); });
pl.on("pageerror", (e) => console.log(`${stamp()} [player pageerror] ${e.message}`));
await pl.goto(`${site}/?p2p=SPIKE&proto=xash&nosound&primer=0&gfx=low`, { waitUntil: "domcontentloaded" });
await pl.fill("#name", "Peer");
await pl.click("#go");
console.log(`${stamp()} [probe] player joining, waiting ${secs}s`);
await new Promise((r) => setTimeout(r, +secs * 1000));
await host.evaluate(() => serverCmd("status"));
await new Promise((r) => setTimeout(r, 3000));
await pl.screenshot({ path: process.env.SHOT || "/tmp/pha4004-p2p.png", timeout: 60000 }).catch((e) => console.log(`${stamp()} [probe] no screenshot: ${e.message.split("\n")[0]}`));
console.log(`${stamp()} [probe] done`);
await playerB.close(); await hostB.close();
