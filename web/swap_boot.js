// Swap in a new boot.js on top of an already hashed public dir (hash_assets.js ran in the base image):
// write boot.<hash>.js, point index.html (script tag + window.__ASSETS) and assets.json at it. The old hashed
// boot.js stays, so a page loaded before the deploy keeps the files it names.
// usage: node swap_boot.js <public dir> <new boot.js>
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
const [dir, src] = process.argv.slice(2);
const buf = fs.readFileSync(src);
const out = `boot.${crypto.createHash("sha256").update(buf).digest("hex").slice(0, 10)}.js`;
const assets = JSON.parse(fs.readFileSync(path.join(dir, "assets.json"), "utf8"));
const old = assets["boot.js"];
if (!old) throw new Error("assets.json has no boot.js");
fs.writeFileSync(path.join(dir, out), buf);
let html = fs.readFileSync(path.join(dir, "index.html"), "utf8");
const n = html.split(old).length - 1;
if (n < 2) throw new Error(`index.html names ${old} ${n} times, expected the script tag and __ASSETS`);
html = html.split(old).join(out);
fs.writeFileSync(path.join(dir, "index.html"), html);
assets["boot.js"] = out;
fs.writeFileSync(path.join(dir, "assets.json"), JSON.stringify(assets, null, 1) + "\n");
console.log(`boot.js: ${old} -> ${out}`);
