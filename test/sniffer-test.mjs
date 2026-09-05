// Media Sniffer 自动化实测脚本
// 用系统 Chrome 加载扩展 → 打开目标页 → 尝试播放 → 读取扩展 SW 内部嗅探结果
import { createRequire } from 'module';
const require = createRequire('C:/Users/candi/.workbuddy/binaries/node/workspace/');
const puppeteer = require('puppeteer-core');
import fs from 'fs';

const EXT = 'K:\\vibecoding\\media-sniffer';
const TARGET = process.argv[2] || 'https://gkinowikiwik.ubhoymtvd.cc/archives/214027/';
const OUT = 'K:\\vibecoding\\media-sniffer\\test\\result.json';

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: false, // 扩展必须非 headless
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    '--autoplay-policy=no-user-gesture-required',
    '--no-first-run',
    '--window-size=1280,800',
  ],
});

const log = [];
const push = (s) => { console.log(s); log.push(s); };

try {
  // 取扩展 ID
  let extId = null;
  for (let i = 0; i < 30; i++) {
    const workers = browser.targets().filter((t) => t.type() === 'service_worker' && /background/.test(t.url()));
    if (workers.length) { extId = workers[0].url().split('/')[2]; break; }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!extId) throw new Error('扩展 Service Worker 未启动');
  push('[1] 扩展已加载, id=' + extId);

  // 在扩展页面上下文执行调试查询
  async function dump() {
    const extPage = await browser.newPage();
    await extPage.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: 'load' });
    const res = await extPage.evaluate(() => new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'debugDump' }, (r) => resolve(r));
    }));
    await extPage.close();
    return res;
  }

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  page.on('console', (m) => { if (/error/i.test(m.type())) push('[页面console] ' + m.text().slice(0, 200)); });

  push('[2] 打开页面: ' + TARGET);
  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => push('goto 警告: ' + e.message.slice(0, 120)));
  await new Promise((r) => setTimeout(r, 8000));

  // 记录阶段1结果
  const snap1 = await dump();
  push('[3] 播放前嗅探: ' + JSON.stringify(snap1, null, 1).slice(0, 3000));

  // 找到 video 元素并点击播放
  const videoInfo = await page.evaluate(() => {
    const v = document.querySelector('video');
    if (!v) return { found: false, iframes: document.querySelectorAll('iframe').length };
    const r = v.getBoundingClientRect();
    return { found: true, src: (v.currentSrc || v.src || '').slice(0, 120), rect: { x: r.x + r.width / 2, y: r.y + r.height / 2 }, w: r.width, h: r.height };
  });
  push('[4] video 元素: ' + JSON.stringify(videoInfo));

  if (videoInfo.found && videoInfo.w > 50) {
    await page.mouse.click(videoInfo.rect.x, videoInfo.rect.y).catch(() => {});
    push('[5] 已点击视频区域');
  } else {
    // 可能在 iframe 里，尝试点击页面中部的播放按钮区域
    const btn = await page.$('.jw-icon-display, .vjs-big-play-button, .play-btn, [class*="play"]');
    if (btn) { await btn.click().catch(() => {}); push('[5] 已点击播放按钮'); }
    else push('[5] 未找到播放入口');
  }

  await new Promise((r) => setTimeout(r, 15000));

  const snap2 = await dump();
  push('[6] 播放后嗅探结果:');
  push(JSON.stringify(snap2, null, 1));

  // 页面所有 iframe URL（排查视频是否在子 iframe）
  const frames = page.frames().map((f) => f.url().slice(0, 150));
  push('[7] frames: ' + JSON.stringify(frames, null, 1));

  fs.writeFileSync(OUT, JSON.stringify({ snap1, snap2, frames, videoInfo, log }, null, 2));
  push('[8] 结果已写入 ' + OUT);
} catch (e) {
  push('ERROR: ' + (e.stack || e.message));
  fs.writeFileSync(OUT, JSON.stringify({ error: String(e), log }, null, 2));
} finally {
  await browser.close().catch(() => {});
}
