// 端到端验证：完整模拟用户操作 → 验证 popup 拿到的数据
import { createRequire } from 'module';
const require = createRequire('C:/Users/candi/.workbuddy/binaries/node/workspace/');
const puppeteer = require('puppeteer-core');
import fs from 'fs';

const EXT = 'K:\\vibecoding\\media-sniffer';
const TARGET = 'https://gkinowikiwik.ubhoymtvd.cc/archives/214027/';

const browser = await puppeteer.launch({
  protocolTimeout: 120000,
  executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: false,
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    '--autoplay-policy=no-user-gesture-required',
    '--no-first-run',
    '--window-size=1280,900',
  ],
});

const log = [];
const push = (s) => { console.log(s); log.push(s); };

try {
  let extId = null;
  for (let i = 0; i < 30; i++) {
    const w = browser.targets().filter((t) => t.type() === 'service_worker' && /background/.test(t.url()));
    if (w.length) { extId = w[0].url().split('/')[2]; break; }
    await new Promise((r) => setTimeout(r, 500));
  }
  push('[1] ext=' + extId);

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 60000 });
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const cur = page.url();
    const next = await page.evaluate(() => location.href).catch(() => cur);
    if (next === cur) break;
  }
  push('[2] 页面稳定: ' + page.url());

  // 滚动到视频并播放（模拟用户）
  await page.evaluate(() => document.querySelector('video').scrollIntoView({ block: 'center' }));
  await new Promise((r) => setTimeout(r, 1500));
  const rect = await page.evaluate(() => {
    const r = document.querySelector('video').getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.click(rect.x, rect.y);
  push('[3] 已点击播放');
  await new Promise((r) => setTimeout(r, 18000));

  // 获取目标 tabId 并模拟 popup 的 get 请求
  const extPage = await browser.newPage();
  await extPage.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: 'load' });
  const popupView = await extPage.evaluate(() => new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    setTimeout(() => finish({ ok: false, reason: 'timeout' }), 8000);
    try {
      chrome.tabs.query({}, (tabs) => {
        if (chrome.runtime.lastError) return finish({ ok: false, reason: chrome.runtime.lastError.message });
        const tab = (tabs || []).find((t) => /gkinowikiwik/.test(t.url || ''));
        if (!tab) return finish({ ok: false, reason: 'tab not found', total: (tabs || []).length });
        chrome.runtime.sendMessage({ type: 'get', tabId: tab.id }, (r) => {
          if (chrome.runtime.lastError) return finish({ ok: false, reason: chrome.runtime.lastError.message });
          finish({ tabId: tab.id, count: (r && r.items || []).length, items: (r && r.items) || [] });
        });
      });
    } catch (e) { finish({ ok: false, reason: String(e) }); }
  }));
  await extPage.close();

  push(`[4] popup 将显示 ${popupView.count} 条资源：`);
  for (const it of popupView.items || []) {
    push(`  [${it.cat}] ${it.filename} | ${it.from} | ${it.url.slice(0, 160)}`);
  }

  const ok = (popupView.items || []).some((i) => i.cat === 'hls');
  push(ok ? '✅ 验证通过：m3u8 已成功嗅探' : '❌ 验证失败：未嗅探到 m3u8');
  fs.writeFileSync('K:\\vibecoding\\media-sniffer\\test\\verify.json', JSON.stringify({ popupView, log }, null, 2));
} catch (e) {
  push('ERROR: ' + (e.stack || e.message).slice(0, 400));
} finally {
  await browser.close().catch(() => {});
}
