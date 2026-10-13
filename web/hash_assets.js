#!/usr/bin/env node
// Content-hashes the engine and code files in a built web/public, in place (run by the Dockerfile, PHA-4234):
//   xash.wasm -> xash.<sha256[:10]>.wasm, and so on for xash.js, fflate.js, boot.js, *.so and *.pk3.
// index.html gets the hashed script URLs plus window.__ASSETS (logical name -> hashed name) for boot.js, which uses
// it for the engine's locateFile and the LIBS fetches. The relay serves a hashed name as `immutable` for a year;
// index.html stays `no-cache` + ETag, so a new build is picked up on the next visit and an old page keeps working
// with the old files it names. gamedata.zip is never renamed or listed: it is key-gated and revalidated by ETag.
// usage: node hash_assets.js [public dir]
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
const dir = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), "public"));
const hashOf = (buf) => crypto.createHash("sha256").update(buf).digest("hex").slice(0, 10);
const HASHED = /\.[0-9a-f]{10}\.[a-z0-9]+$/;
const names = fs.readdirSync(dir).filter((f) => /\.(wasm|so|pk3|js)$/.test(f) && !HASHED.test(f) && !/\.live\.|\.test\./.test(f));
const read = (f) => fs.readFileSync(path.join(dir, f));
const assets = {};
const rename = (f, buf) => {
  const ext = path.extname(f), out = `${path.basename(f, ext)}.${hashOf(buf)}${ext}`;
  fs.writeFileSync(path.join(dir, out), buf); fs.unlinkSync(path.join(dir, f)); assets[f] = out;
};
// boot.js holds only the logical names; it is hashed last, after everything else it must not see changes
for (const f of names.filter((f) => f !== "boot.js")) rename(f, read(f));
if (names.includes("boot.js")) rename("boot.js", read("boot.js"));
let html = fs.readFileSync(path.join(dir, "index.html"), "utf8");
const before = html;
html = html.replace(/<script src="(fflate\.js|xash\.js|boot\.js)(\?[^"]*)?"><\/script>/g, (m, f) => `<script src="${assets[f]}"></script>`);
if (html === before) throw new Error("index.html: no script tags rewritten");
html = html.replace(/(<script src="fflate)/, `<script>window.__ASSETS=${JSON.stringify(assets)};</script>\n$1`);
fs.writeFileSync(path.join(dir, "index.html"), html);
fs.writeFileSync(path.join(dir, "assets.json"), JSON.stringify(assets, null, 1) + "\n");
console.log(`hashed ${Object.keys(assets).length} files in ${dir}`);
