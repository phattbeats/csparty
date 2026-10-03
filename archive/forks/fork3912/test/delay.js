const { chromium } = require('playwright');
(async => {
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const hook = => { const A = window.Audio; window.Audio = function (...a) { const el = new A(...a); window.__music = el; return el; }; };
  const m = (pg) => pg.evaluate(() => ({ paused: __music.paused, vol: +__music.volume.toFixed(3) }));
  let pg = await b.newPage(); await pg.addInitScript(hook);
  const t0 = Date.now(); await pg.goto(`http://127.0.0.1:8095/?key=${process.env.KEY}`);
  for (const t of [3, 10, 19, 21, 23, 25]) { await pg.waitForTimeout(t * 1000 - (Date.now() - t0)); console.log('auto', t + 's', JSON.stringify(await m(pg))); }
  pg = await b.newPage(); await pg.addInitScript(hook); await pg.goto(`http://127.0.0.1:8095/?key=${process.env.KEY}`); await pg.waitForTimeout(2000);
  await pg.click('#music-mute'); await pg.click('#music-mute'); await pg.waitForTimeout(800);
  console.log('mute+unmute at 2s', JSON.stringify(await m(pg)));
  pg = await b.newPage(); await pg.addInitScript(hook); await pg.goto(`http://127.0.0.1:8095/?key=${process.env.KEY}`); await pg.waitForTimeout(2000);
  await pg.fill('#name', 'x'); await pg.click('#go'); await pg.waitForTimeout(21000);
  console.log('joined at 2s, 23s', JSON.stringify(await m(pg)));
  await b.close();
})();
