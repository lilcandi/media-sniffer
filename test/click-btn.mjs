// 真实模拟用户：加载扩展 → 打开目标站 → 等嗅探到 m3u8 → 打开 popup → 真实点击「🎬 下载完整视频」按钮
// 观察：status 是否变化 / 是否有 console 错误 / download 是否发起
import { createRequire } from 'module';
const require = createRequire('C:/Users/candi/.workbuddy/binaries/node/workspace/');
const puppeteer = require('puppeteer-core');
import fs from 'fs';

const EXT = 'K:\\vibecoding\\media-sniffer';
const TARGET = process.env.TARGET || 'https://gkinowikiwik.ubhoymtvd.cc/archives/214027/';
const OUT = 'K:\\vibecoding\\media-sniffer\\test\\click-btn.json';
const log = [];
const push = (s) => { console.log(s); log.push(s); };

const browser = await puppeteer.launch({
  protocolTimeout: 150000,
  executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: false,
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    '--autoplay-policy=no-user-gesture-required',
    '--no-first-run',
    '--window-size=1300,900',
  ],
});

try {
  let extId = null;
  for (let i = 0; i < 30; i++) {
    const w = browser.targets().filter((t) => t.type() === 'service_worker' && /background/.test(t.url()));
    if (w.length) { extId = w[0].url().split('/')[2]; break; }
    await new Promise((r) => setTimeout(r, 500));
  }
  push('[1] ext=' + extId);

  const page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'error') push('  [页面console-error] ' + m.text().slice(0, 300)); });
  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 90000 });
  // 等域名稳定
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const cur = page.url(); const next = await page.evaluate(() => location.href).catch(() => cur);
    if (next === cur) break;
  }
  push('[2] 页面稳定: ' + page.url());

  // 滚动到视频并点击播放（真实用户动作）
  try {
    await page.evaluate(() => { const v = document.querySelector('video'); if (v) v.scrollIntoView({ block: 'center' }); });
    await new Promise((r) => setTimeout(r, 1500));
    const rect = await page.evaluate(() => {
      const v = document.querySelector('video'); const r = v.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, ok: r.width > 40 };
    });
    if (rect.ok) { await page.mouse.click(rect.x, rect.y); push('[3] 已点击播放'); }
  } catch (e) { push('[3] 无 video 或点击失败: ' + e.message); }
  // 等待嗅探 + 拉流
  await new Promise((r) => setTimeout(r, 20000));

  // 打开 popup（真实页面，能看到按钮并真实点击）
  const popup = await browser.newPage();
  popup.on('console', (m) => { if (m.type() === 'error') push('  [popup-console-error] ' + m.text().slice(0, 400)); });
  popup.on('pageerror', (e) => push('  [popup-pageerror] ' + String(e && e.stack || e).slice(0, 400)));
  await popup.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: 'load', timeout: 30000 });
  await new Promise((r) => setTimeout(r, 1500));

  // 看 popup 当前嗅探结果
  const items = await popup.evaluate(() => {
    const list = document.querySelectorAll('#list .item');
    const out = [];
    for (const card of list) {
      const badge = card.querySelector('.badge');
      const name = card.querySelector('.filename');
      const btns = [...card.querySelectorAll('.actions button')].map((b) => b.textContent);
      out.push({ cat: badge && badge.textContent, name: name && name.textContent.slice(0, 60), btns, disabled: !!card.querySelector('.btn.primary:disabled') });
    }
    return out;
  });
  push('[4] popup 渲染条目: ' + JSON.stringify(items, null, 0).slice(0, 800));

  // 找「下载完整视频」或「完整视频」按钮真实点击
  const clicked = await popup.evaluate(() => {
    const btns = [...document.querySelectorAll('#list .btn.primary')];
    if (!btns.length) return { ok: false, reason: 'no-primary-btn' };
    const btn = btns.find((b) => /完整视频|下载完整视频/.test(b.textContent)) || btns[0];
    // 记录点击前 status
    const before = document.querySelector('#status').textContent;
    const wasDisabled = btn.disabled;
    btn.click();
    return { ok: true, text: btn.textContent, wasDisabled, beforeStatus: before };
  });
  push('[5] 点击结果: ' + JSON.stringify(clicked));

  // 等待看 status 变化
  await new Promise((r) => setTimeout(r, 4000));
  const afterStatus = await popup.evaluate(() => {
    const s = document.querySelector('#status');
    return { status: s ? s.textContent : '(no #status)', btnDisabled: !!document.querySelector('.btn.primary:disabled') };
  });
  push('[6] 点击 4s 后 status: ' + JSON.stringify(afterStatus));

  // 查 downloads 看是否发起
  const dl = await popup.evaluate(() => new Promise((resolve) => {
    chrome.downloads.search({ limit: 8, orderBy: ['-startTime'] }, (items) => {
      resolve((items || []).map((i) => ({ f: i.filename, st: i.state, b: i.bytesReceived, t: i.totalBytes, url: (i.url || '').slice(0, 50) })));
    });
  }));
  push('[7] 最近 downloads: ' + JSON.stringify(dl, null, 0));

  fs.writeFileSync(OUT, JSON.stringify({ items, clicked, afterStatus, dl, log }, null, 2));
} catch (e) {
  push('ERROR: ' + (e.stack || e.message).slice(0, 600));
  fs.writeFileSync(OUT, JSON.stringify({ error: String(e), log }, null, 2));
} finally {
  await browser.close().catch(() => {});
}
