// ISSUE check: menu music (default 10%, slider, mute, autoplay fallback) and the game-end theme.
const { chromium } = require('playwright');
const fs = require('fs');
const URL = `http://127.0.0.1:8095/?key=${process.env.KEY}&char=1&nosound`;
const st = (pg) => pg.evaluate(() => { const a = [...document.querySelectorAll('audio')][0]; return null; });
(async => {
  // A: default autoplay policy (needs a gesture)
  let b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  let pg = await b.newPage({ viewport: { width: 640, height: 400 } });
  pg.on('pageerror', e => console.log('PAGEERROR', e.message));
  // expose the Audio element: wrap the constructor before boot.js runs
  const hook = => { const A = window.Audio; window.Audio = function (...a) { const el = new A(...a); window.__music = el; return el; }; };
  await pg.addInitScript(hook);
  await pg.goto(URL); await pg.waitForTimeout(2000);
  const ms = => pg.evaluate(() => ({ paused: __music.paused, vol: +__music.volume.toFixed(2), loop: __music.loop, slider: document.getElementById('music-vol').value, label: document.getElementById('music-vol-v').textContent, visible: !!document.getElementById('music').offsetParent || getComputedStyle(document.getElementById('music')).display !== 'none' }));
  console.log('A load (no gesture):', JSON.stringify(await ms()));
  await pg.mouse.click(100, 300); await pg.waitForTimeout(1500);
  console.log('A after click:', JSON.stringify(await ms()), 'time', await pg.evaluate(() => __music.currentTime.toFixed(1)));
  await pg.click('#music-mute'); await pg.waitForTimeout(500);
  console.log('A after mute:', JSON.stringify(await ms()), 'muted class', await pg.evaluate(() => document.getElementById('music').className));
  await pg.click('#music-mute'); await pg.waitForTimeout(800);
  console.log('A after unmute:', JSON.stringify(await ms()));
  await pg.screenshot({ path: '/out/menu.png' });
  await b.close();
  // B: join, spectate, wait for CSP_THEME_PLAY at match end
  b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
  pg = await b.newPage({ viewport: { width: 640, height: 400 } });
  await pg.addInitScript(hook);
  pg.on('pageerror', e => console.log('PAGEERROR', e.message));
  pg.on('console', m => { const t = m.text(); if (/CSP_THEME|\[watch\] state|wins CS Party/.test(t)) console.log('CONSOLE', t.slice(0, 160)); });
  await pg.goto(URL); await pg.waitForTimeout(1500);
  console.log('B load (autoplay allowed):', JSON.stringify(await ms()));
  await pg.fill('#name', 'ThemeTest'); await pg.click('#go');
  await pg.waitForTimeout(4000);
  console.log('B after join click (fading):', JSON.stringify(await pg.evaluate(() => ({ paused: __music.paused, vol: __music.volume.toFixed(2) }))));
  let last = '';
  for (let t = 0; t < 280 && !fs.existsSync('/out/STOP'); t++) {
    await new Promise(r => setTimeout(r, 2000));
    const s = JSON.stringify(await pg.evaluate(() => ({ paused: __music.paused, loop: __music.loop, vol: +__music.volume.toFixed(2), t: Math.round(__music.currentTime) > 0 })));
    if (s !== last) { console.log('B music', new Date().toISOString().slice(11, 19), s); last = s; }
    if (fs.existsSync('/out/SNAP')) { fs.unlinkSync('/out/SNAP'); await pg.screenshot({ path: '/out/end.png', timeout: 90000 }).catch(e => console.log('shot fail')); }
  }
  await b.close();
})();
