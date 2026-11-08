// PHA-4004 spike: one headless browser player joins a page and stays for a while, so we can tell whether the
// shipped CS Party browser client gets into a game hosted by the wasm server. No page calls while the engine
// runs (docs/dev-harness.md: DevTools calls during a join balloon the renderer); the server log is the judge.
//
// usage: PW=<path to playwright-core> CHROME=<chrome-headless-shell> node join_probe.mjs <url> [seconds] [name]
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)(process.env.PW);
const [url, secs = "90", name = "Probe"] = process.argv.slice(2);
const shot = process.env.SHOT || "/tmp/pha4004-probe.png";

const b = await chromium.launch({
  executablePath: process.env.CHROME,
  args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--autoplay-policy=no-user-gesture-required", "--no-sandbox"],
});
const pg = await b.newPage({ viewport: { width: 960, height: 600 } });
const t0 = Date.now(), stamp = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6);
pg.on("console", (m) => {
  const t = m.text();
  if (process.env.ALL || /connect|entered|Disconnect|refused|error|relay|ICE|channel|signal|timed out|joined|map|p2p/i.test(t)) console.log(`${stamp()} [page] ${t.slice(0, 200)}`);
});
pg.on("pageerror", (e) => console.log(`${stamp()} [pageerror] ${e.message}`));
await pg.goto(url, { waitUntil: "domcontentloaded" });
await pg.fill("#name", name);
await pg.click("#go");
console.log(`${stamp()} [probe] joined the page, waiting ${secs}s`);
await new Promise((r) => setTimeout(r, +secs * 1000));
await pg.screenshot({ path: shot, timeout: 60000 }).then(() => console.log(`${stamp()} [probe] screenshot ${shot}`), (e) => console.log(`${stamp()} [probe] no screenshot: ${e.message.split("\n")[0]}`));
await b.close();
