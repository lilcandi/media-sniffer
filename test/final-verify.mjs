// 一次性完整验证：真实站点嗅探→立即下载→轮询 chrome.downloads 直到落盘，确认文件真实存在
import { createRequire } from 'module';
const require = createRequire('C:/Users/candi/.workbuddy/binaries/node/workspace/');
const puppeteer = require('puppeteer-core');
import fs from 'fs';
import os from 'os';
import path from 'path';

const EXT = 'K:\\vibecoding\\media-sniffer';
const TARGET = 'https://gkinowikiwik.ubhoymtvd.cc/archives/214027/';
const LOG = [];
const push = (s) => { console.log(s); LOG.push(s); };

// 使用临时下载目录，避免污染真实下载
const DL = path.join(os.tmpdir(), 'msniff-final-' + Date.now());
fs.mkdirSync(DL, { recursive: true });

const browser = await puppeteer.launch({
  protocolTimeout: 300000,
  executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: false,
  args: [
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    '--autoplay-policy=no-user-gesture-required', '--no-first-run', '--window-size=1280,900',
    `--download.default_directory=${DL}`,
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
  push('[1] 页面: ' + page.url());

  // 点播放获取新鲜 m3u8
  await page.evaluate(() => { const v = document.querySelector('video'); if (v) { v.scrollIntoView({ block: 'center' }); try { v.play(); } catch (e) {} } });
  await new Promise((r) => setTimeout(r, 3000));
  try {
    const rect = await page.evaluate(() => { const v = document.querySelector('video'); if (!v) return null; const r = v.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    if (rect) await page.mouse.click(rect.x, rect.y);
  } catch (e) {}
  await new Promise((r) => setTimeout(r, 6000));

  const info = await withEp(extId, (ep) => ep.evaluate(() => new Promise((resolve) => {
    chrome.tabs.query({}, (tabs) => {
      const tab = (tabs || []).find((t) => /gkinowikiwik|ftpuvrpme|lwvldygi/.test(t.url || ''));
      if (!tab) return resolve(null);
      chrome.runtime.sendMessage({ type: 'get', tabId: tab.id }, (r) => resolve({ tabId: tab.id, title: tab.title, items: (r && r.items) || [] }));
    });
  })));
  const hls = (info.items || []).filter((i) => i.cat === 'hls' && !/^blob:/.test(i.url));
  const m3u8url = hls[0] && hls[0].url;
  push('[2] hls=' + hls.length + ' url=' + (m3u8url || '').slice(0, 120));
  if (!m3u8url) { push('❌ 无hls'); await browser.close(); process.exit(0); }

  // 触发下载（fire，不 await sendResponse 阻塞太久——直接发，后台会跑）
  const t0 = Date.now();
  const fireRet = await withEp(extId, (ep, a) => ep.evaluate(({ u, tid, title }) => new Promise((resolve) => {
    let done = false; const finish = (v) => { if (!done) { done = true; resolve(v); } };
    // send 阻塞到合并完成；但我们在另一页轮询 downloads，这里给 90s 上限
    chrome.runtime.sendMessage({ type: 'downloadM3u8', url: u, tabId: tid, title }, (r) => finish(r || {}));
  }), { u: m3u8url, tid: info.tabId, title: info.title }));
  push('[3] downloadM3u8 返回用时' + (Date.now() - t0) + 'ms: ' + JSON.stringify(fireRet).slice(0, 200));

  // 轮询 downloads 直到 complete 或 error 或超时 6 分钟
  const epP = await browser.newPage();
  await epP.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: 'load', timeout: 30000 });
  let finalItem = null;
  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 4000));
    const st = await epP.evaluate(() => new Promise((resolve) => {
      chrome.downloads.search({ limit: 5 }, (ds) => resolve((ds || []).map((d) => ({ id: d.id, state: d.state, error: d.error || null, filename: d.filename, bytes: d.bytesReceived, total: d.totalBytes }))));
    }));
    const running = st.find((d) => d.state === 'in_progress');
    push(`[4-${i}] ` + st.map((d) => `id${d.id}:${d.state}${d.error ? '/' + d.error : ''} ${d.bytes}/${d.total}`).join(' | '));
    const done = st.find((d) => d.state === 'complete');
    const failed = st.find((d) => d.state === 'interrupted');
    if (done) { finalItem = done; push('[5] ✅ 下载完成 id=' + done.id + ' bytes=' + done.bytes); break; }
    if (failed) { finalItem = failed; push('[5] ❌ 下载中断 error=' + failed.error); break; }
    if (!running && i > 6) { push('[5] ⚠️ 无进行中下载且未完成——可能已失败'); break; }
  }
  await epP.close();

  // 若完成，验证文件在 DL 目录存在且大小匹配
  if (finalItem && finalItem.state === 'complete') {
    const files = fs.readdirSync(DL);
    push('[6] 下载目录文件: ' + JSON.stringify(files.map((f) => { try { return f + '=' + fs.statSync(path.join(DL, f)).size; } catch (e) { return f + '=?'; } })));
    // 可能文件被写到别处（blob URL 下载可能不进 default dir）。查 downloads 的完整 path
    const p2 = await withEp(extId, (ep, did) => ep.evaluate((argDid) => new Promise((resolve) => {
      chrome.downloads.search({ id: argDid }, (ds) => resolve(ds[0] ? { filename: ds[0].filename, state: ds[0].state, error: ds[0].error } : null));
    }), did), finalItem.id);
    push('[7] 实际保存路径: ' + JSON.stringify(p2));
  }

  fs.writeFileSync('K:\\vibecoding\\media-sniffer\\test\\final-verify.json', JSON.stringify({ LOG, DL, fireRet }, null, 2));
} catch (e) {
  push('ERROR: ' + (e.stack || e.message).slice(0, 800));
} finally {
  await browser.close().catch(() => {});
}
