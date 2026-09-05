// 场景测试：A) 不播放纯加载 B) 点击播放 —— 验证响应体扫描兜底
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

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 60000 });
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const cur = page.url();
    const next = await page.evaluate(() => location.href).catch(() => cur);
    if (next === cur) break;
  }
  push('[1] 页面稳定: ' + page.url());

  async function dumpMedia(tag) {
    const extPage = await browser.newPage();
    await extPage.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: 'load', timeout: 30000 });
    const view = await extPage.evaluate(() => new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      setTimeout(() => finish({ ok: false, reason: 'timeout' }), 8000);
      chrome.tabs.query({}, (tabs) => {
        const tab = (tabs || []).find((t) => /gkinowikiwik/.test(t.url || ''));
        if (!tab) return finish({ ok: false, reason: 'no tab' });
        chrome.runtime.sendMessage({ type: 'get', tabId: tab.id }, (r) => {
          finish({ items: (r && r.items) || [] });
        });
      });
    }));
    await extPage.close();
    const media = (view.items || []).filter((i) => ['hls', 'dash', 'segment', 'video', 'audio'].includes(i.cat));
    push(`[${tag}] 媒体 ${media.length} 条:`);
    for (const m of media) push(`  [${m.cat}] from=${m.from} | ${m.url.slice(0, 160)}`);
    return media;
  }

  // 场景 A：只加载，不点击播放（等待源码重扫 + 响应体扫描）
  push('[2] 场景A：不播放，等待 50 秒...');
  await new Promise((r) => setTimeout(r, 50000));
  const mediaA = await dumpMedia('A-不播放');

  // 场景 B：点击播放
  await page.evaluate(() => {
    const v = document.querySelector('video');
    if (v) v.scrollIntoView({ block: 'center' });
  });
  await new Promise((r) => setTimeout(r, 1500));
  const rect = await page.evaluate(() => {
    const r = document.querySelector('video').getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.click(rect.x, rect.y);
  push('[3] 已点击播放，等待 15 秒...');
  await new Promise((r) => setTimeout(r, 15000));
  const mediaB = await dumpMedia('B-播放后');

  push(mediaA.some((m) => m.cat === 'hls') ? '✅ 场景A通过：不播放也能抓到 m3u8' : '⚠️ 场景A：不播放时没抓到 m3u8（需播放）');
  push(mediaB.some((m) => m.cat === 'hls') ? '✅ 场景B通过：播放后抓到 m3u8' : '❌ 场景B失败');
  fs.writeFileSync('K:\\vibecoding\\media-sniffer\\test\\scenario.json', JSON.stringify({ mediaA, mediaB, log }, null, 2));
} catch (e) {
  push('ERROR: ' + (e.stack || e.message).slice(0, 400));
} finally {
  await browser.close().catch(() => {});
}
