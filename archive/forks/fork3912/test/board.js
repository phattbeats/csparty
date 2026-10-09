// #3912 check: board music during the board phase, fade-out for minigames, theme at game end.
const { chromium } = require('playwright');
const fs = require('fs');
const URL = `http://127.0.0.1:8095/?key=${process.env.KEY}&char=1&nosound`;
(async => {
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
  const pg = await b.newPage({ viewport: { width: 640, height: 400 } });
  await pg.addInitScript(() => { const A = window.Audio; window.__auds = []; window.Audio = function (...a) { const el = new A(...a); __auds.push(el); return el; }; });
  pg.on('pageerror', e => console.log('PAGEERROR', e.message));
  pg.on('console', m => { const t = m.text(); if (/CSP_THEME|CSP_MUSIC|wins CS Party|Match start|Back to the board/.test(t)) console.log('CONSOLE', new Date().toISOString().slice(11, 19), t.slice(0, 140)); });
  await pg.goto(URL); await pg.waitForTimeout(1500);
  await pg.fill('#name', 'BoardTest'); await pg.click('#go');
  let last = '';
  for (let t = 0; t < 280 && !fs.existsSync('/out/STOP'); t++) {
    await new Promise(r => setTimeout(r, 2000));
    const s = JSON.stringify(await pg.evaluate(() => __auds.map(a => ({ src: (a.src || '').split('/').pop(), paused: a.paused, vol: +a.volume.toFixed(2), loop: a.loop, err: a.error && a.error.code }))));
    if (s !== last) { console.log('AUDIO', new Date().toISOString().slice(11, 19), s); last = s; }
  }
  await b.close();
})();
