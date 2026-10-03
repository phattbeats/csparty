const { chromium } = require('playwright');
(async => {
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  for (const [w, h] of [[640, 400], [1280, 720], [390, 800]]) {
    const pg = await b.newPage({ viewport: { width: w, height: h } });
    await pg.goto(`http://127.0.0.1:8095/?key=${process.env.KEY}`); await pg.waitForTimeout(1500);
    await pg.screenshot({ path: `/out/menu-${w}.png` }); await pg.close();
  }
  await b.close();
})();
