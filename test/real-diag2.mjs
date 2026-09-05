// 真实站点诊断 v2：嗅探到 m3u8 立刻下载（缩短 auth_key 过期窗口），完整拿 SW 终态
import { createRequire } from 'module';
const require = createRequire('C:/Users/candi/.workbuddy/binaries/node/workspace/');
const puppeteer = require('puppeteer-core');
import fs from 'fs';

const EXT = 'K:\\vibecoding\\media-sniffer';
const TARGET = 'https://gkinowikiwik.ubhoymtvd.cc/archives/214027/';
const LOG = [];
const push = (s) => { console.log(s); LOG.push(s); };

const browser = await puppeteer.launch({
  protocolTimeout: 300000,
  executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: false,
  args: [
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    '--autoplay-policy=no-user-gesture-required', '--no-first-run', '--window-size=1280,900',
  ],
});

async function withEp(extId, fn, arg) {
  const ep = await browser.newPage();
  await ep.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: 'load', timeout: 30000 });
  const r = await fn(ep, arg);
  await ep.close();
  return r;
}

try {
  let extId = null;
  for (let i = 0; i < 30; i++) {
    const w = browser.targets().filter((t) => t.type() === 'service_worker' && /background/.test(t.url()));
    if (w.length) { extId = w[0].url().split('/')[2]; break; }
    await new Promise((r) => setTimeout(r, 500));
  }
  push('ext=' + extId);

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 60000 });
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const cur = page.url(); const next = await page.evaluate(() => location.href).catch(() => cur);
    if (next === cur) break;
  }
  push('[1] 页面稳定: ' + page.url());

  // 点播放以触发真实 m3u8（新鲜 auth_key）
  await page.evaluate(() => {
    const v = document.querySelector('video');
    if (v) { v.scrollIntoView({ block: 'center' }); try { v.play(); } catch (e) {} }
  });
  await new Promise((r) => setTimeout(r, 4000));
  try {
    const rect = await page.evaluate(() => { const v = document.querySelector('video'); if (!v) return null; const r = v.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    if (rect) await page.mouse.click(rect.x, rect.y);
  } catch (e) {}
  push('[2] 已点播放');
  await new Promise((r) => setTimeout(r, 6000));

  // 立刻拿 hls 条目
  const info = await withEp(extId, (ep) => ep.evaluate(() => new Promise((resolve) => {
    chrome.tabs.query({}, (tabs) => {
      const tab = (tabs || []).find((t) => /gkinowikiwik|lwvldygi|ubhoymtvd|ftpuvrpme/.test(t.url || ''));
      if (!tab) return resolve(null);
      chrome.runtime.sendMessage({ type: 'get', tabId: tab.id }, (r) => resolve({ tabId: tab.id, title: tab.title, items: (r && r.items) || [] }));
    });
  })));
  const hls = (info.items || []).filter((i) => i.cat === 'hls' && !/^blob:/.test(i.url));
  push('[3] hls入口=' + hls.length + '  title=' + info.title);
  const m3u8url = hls[0] && hls[0].url;
  if (!m3u8url) { push('❌ 无 hls'); await browser.close(); process.exit(0); }
  push('  入口=' + m3u8url.slice(0, 200));

  // 立刻触发下载（auth_key 还新鲜）
  const ret = await withEp(extId, (ep, a) => ep.evaluate(({ u, tid, title }) => new Promise((resolve) => {
    let done = false; const finish = (v) => { if (!done) { done = true; resolve(v); } };
    setTimeout(() => finish({ timeout: true }), 200000);
    chrome.runtime.sendMessage({ type: 'downloadM3u8', url: u, tabId: tid, title }, (r) => finish(r));
  }), a), { u: m3u8url, tid: info.tabId, title: info.title });
  push('[4] 下载返回(直接): ' + JSON.stringify(ret).slice(0, 400));
  if (ret && ret.timeout) push('  !! downloadM3u8 sendMessage 超时20s未返回 —— SW 在处理或 channel 卡住');

  // long-poll 拿 storage 终态
  const last = await withEp(extId, (ep, tid) => ep.evaluate((tid) => new Promise((resolve) => {
    let i = 0; const tick = () => {
      chrome.runtime.sendMessage({ type: 'getLastDownload', tabId: tid }, (r) => {
        const l = r && r.last;
        if (l && (l.name || l.error || l.stack)) return resolve(l);
        if (++i >= 60) return resolve({ timeout: true });
        setTimeout(tick, 500);
      });
    }; tick();
  }), tid), info.tabId);
  push('[5] long-poll 终态: ' + JSON.stringify(last).slice(0, 500));

  // 查进度
  const prog = await withEp(extId, (ep) => ep.evaluate(() => new Promise((res) => chrome.runtime.sendMessage({ type: 'getMergeProgress' }, (r) => res(r)))));
  push('[6] mergeProgress: ' + JSON.stringify(prog).slice(0, 200));

  fs.writeFileSync('K:\\vibecoding\\media-sniffer\\test\\real-diag2.json', JSON.stringify({ LOG, info, m3u8url, ret, last, prog }, null, 2));
} catch (e) {
  push('ERROR: ' + (e.stack || e.message).slice(0, 800));
} finally {
  await browser.close().catch(() => {});
}
