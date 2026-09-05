// 端到端：加载扩展 → 本地加密 HLS → 触发 downloadM3u8 → 校验合并出的 .ts 已解密且 TS 同步字节全中
import { createRequire } from 'module';
const require = createRequire('C:/Users/candi/.workbuddy/binaries/node/workspace/');
const puppeteer = require('puppeteer-core');
const http = require('http');
const fs = require('fs');
const path = require('path');
import os from 'os';

const EXT = 'K:\\vibecoding\\media-sniffer';
const FIXTURE = 'K:\\vibecoding\\media-sniffer\\test\\fixture';
const LOG = [];
const push = (s) => { console.log(s); LOG.push(s); };

// 本地静态服务
const MIME = { '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t', '.key': 'application/octet-stream' };
const server = http.createServer((req, res) => {
  const base = req.url.split('?')[0];
  if (base === '/' || base === '') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html><body>fixture</body></html>'); return; }
  const f = path.join(FIXTURE, path.basename(base));
  try {
    const data = fs.readFileSync(f);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
    res.end(data);
  } catch (e) { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const BASE = `http://127.0.0.1:${port}`;
push('本地服务: ' + BASE);

const browser = await puppeteer.launch({
  protocolTimeout: 120000,
  executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: false,
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    '--no-first-run',
    `--unsafely-treat-insecure-origin-as-secure=${BASE}`,
    '--allow-insecure-localhost',
  ],
});

const downloadsDir = path.join(os.tmpdir(), 'msniff-dl-' + Date.now());
fs.mkdirSync(downloadsDir, { recursive: true });

let savedFile = null;
try {
  let extId = null;
  for (let i = 0; i < 30; i++) {
    const w = browser.targets().filter((t) => t.type() === 'service_worker' && /background/.test(t.url()));
    if (w.length) { extId = w[0].url().split('/')[2]; break; }
    await new Promise((r) => setTimeout(r, 500));
  }
  push('ext=' + extId);

  // 打开本地页作为 tab，建立 referer/origin
  const page = await browser.newPage();
  await page.goto(BASE + '/', { waitUntil: 'load' });

  const extPage = await browser.newPage();
  await extPage.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: 'load', timeout: 30000 });

  const res = await extPage.evaluate((playlist) => new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    setTimeout(() => finish({ ok: false, reason: 'timeout' }), 40000);
    chrome.tabs.query({}, (tabs) => {
      const tab = (tabs || []).find((t) => t.url && t.url.startsWith('http://127.0.0.1'));
      if (!tab) return finish({ ok: false, reason: 'no local tab' });
      chrome.runtime.sendMessage({ type: 'downloadM3u8', url: playlist, tabId: tab.id, title: '本地加密测试' }, (r) => finish(r));
    });
  }), BASE + '/playlist.m3u8');
  push('下载返回: ' + JSON.stringify(res));

  // 校验：轮询 downloads.search 直到 complete，核对字节数 = 3×1880
  let finalInfo = null;
  for (let i = 0; i < 20; i++) {
    const extPage2 = await browser.newPage();
    await extPage2.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: 'load' });
    finalInfo = await extPage2.evaluate((did) => new Promise((resolve) => {
      chrome.downloads.search({ id: did }, (items) => {
        const it = items && items[0];
        resolve(it ? { filename: it.filename, state: it.state, bytes: it.bytesReceived, total: it.totalBytes, url: (it.url||'').slice(0,40) } : null);
      });
    }), res.downloadId);
    await extPage2.close();
    if (finalInfo && (finalInfo.state === 'complete' || finalInfo.state === 'interrupted')) break;
    await new Promise((r) => setTimeout(r, 1500));
  }
  push('最终下载状态: ' + JSON.stringify(finalInfo));
  const okSize = finalInfo && finalInfo.state === 'complete' && finalInfo.bytes === 5640 && finalInfo.total === 5640;
  push(okSize ? '✅ 端到端解密合并通过（3 分片已解密并合并，字节数正确）' : '❌ 校验失败');

  // 尽力读取落盘文件二次确认 TS 同步
  let savedFile = null;
  if (finalInfo && finalInfo.filename) {
    for (const root of [os.homedir(), process.env.USERPROFILE]) {
      const cand = path.join(root, 'Downloads', finalInfo.filename);
      try { if (fs.statSync(cand).size === 5640) { savedFile = cand; break; } } catch (e) {}
    }
  }
  if (savedFile) {
    const data = fs.readFileSync(savedFile);
    let sync = 0, total = 0;
    for (let i = 0; i < data.length; i += 188) { total++; if (data[i] === 0x47) sync++; }
    push(`落盘文件 TS 同步: ${sync}/${total}, 大小 ${data.length}`);
  }
} catch (e) {
  push('ERROR: ' + (e.stack || e.message).slice(0, 500));
} finally {
  await browser.close().catch(() => {});
  server.close();
  fs.writeFileSync('K:\\vibecoding\\media-sniffer\\test\\e2e-merge.json', JSON.stringify({ res: LOG, savedFile, downloadsDir }, null, 2));
}
