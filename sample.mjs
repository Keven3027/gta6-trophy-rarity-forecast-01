// Sample the live Exophase page: players tracked + every trophy rate.
// Appends one JSON line per run to /root/makefun/work-forecast/samples.jsonl
import { chromium } from '/root/.nvm/versions/node/v22.13.1/lib/node_modules/playwright/index.mjs';
import { appendFileSync } from 'node:fs';

const url = 'https://www.exophase.com/game/grand-theft-auto-vi-psn/trophies/';
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' });
try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(20000);
  const data = await page.evaluate(() => {
    const text = document.body.innerText;
    // players tracked: look for a "Players" stat in the header area
    let players = null;
    const pm = text.match(/([\d,]+)\s*Players/i);
    if (pm) players = Number(pm[1].replace(/,/g, ''));
    let trophiesEarned = null;
    const tm = text.match(/([\d,]+)\s*Trophies Earned/i);
    if (tm) trophiesEarned = Number(tm[1].replace(/,/g, ''));
    // trophy rows: name then rarity "x.xx%"
    const rows = [];
    const els = document.querySelectorAll('[itemtype], .game-trophy, li, tr');
    // fallback: regex whole text for "name ... rate%" patterns
    return { players, trophiesEarned, text: text.slice(0, 4000) };
  });
  console.log(JSON.stringify({ players: data.players, te: data.trophiesEarned }, null, 0));
  console.log('--- first 3000 chars of text ---');
  console.log(data.text.slice(0, 3000));
} catch (e) {
  console.error('ERR', e.message);
} finally {
  await browser.close();
}
