// Headless browser player for the Two Towers check. Joins the live relay; the host script drives RCON and
// asks for screenshots by touching /out/SNAP_<name>; /out/STOP ends it. Small viewport: swiftshader is slow.
const { chromium } = require('playwright');
const fs = require('fs');
(async => {
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
  const pg = await b.newPage({ viewport: { width: 640, height: 400 } });
  pg.on('pageerror', e => console.log('PAGEERROR', e.message));
  await pg.goto(`http://127.0.0.1:8095/?key=${process.env.KEY}&char=1&nosound`);
  await pg.fill('#name', 'TowerTest');
  await pg.click('#go');
  for (let t = 0; t < 900 && !fs.existsSync('/out/STOP'); t++) {
    await new Promise(r => setTimeout(r, 2000));
    for (const f of fs.readdirSync('/out').filter(f => f.startsWith('SNAP_'))) {
      fs.unlinkSync('/out/' + f);
      try { await pg.screenshot({ path: `/out/${f.slice(5)}.png`, timeout: 90000 }); console.log('shot', f); }
      catch (e) { console.log('shot failed', f, e.message.split('\n')[0]); }
    }
  }
  await b.close();
})();
