// 真实点击测试：本地 fixture 加密 HLS → 让扩展嗅探到 m3u8(hls) 条目 → 真实打开 popup 并点击「下载完整视频」按钮
// 观察按钮点击后是否有明确状态反馈 + 下载是否发起
import { createRequire } from 'module';
const require = createRequire('C:/Users/candi/.workbuddy/binaries/node/workspace/');
const puppeteer = require('puppeteer-core');
const http = require('http');
const fs = require('fs');
const path = require('path');
import os from 'os';
import crypto from 'crypto';

const EXT = 'K:\\vibecoding\\media-sniffer';
const FIXTURE = 'K:\\vibecoding\\media-sniffer\\test\\fixture-click';
const log = [];
const push = (s) => { console.log(s); log.push(s); };

// --- 准备加密 HLS fixture：3 分片，同步字节 0x47 ---
const KEY = crypto.randomBytes(16);
function makeTs(seq) { const b = Buffer.alloc(188 * 5); for (let i = 0; i < 5; i++) { b[i*188]=0x47; b[i*188+1]=0x40; } b.writeUInt32BE(seq, 4); return b; }
function enc(b, key, iv) { const c = crypto.createCipheriv('aes-128-cbc', key, iv); return Buffer.concat([c.update(b), c.final()]); }
fs.mkdirSync(FIXTURE, { recursive: true });
const ID = 'democlip0001';
const playlistText = [
  '#EXTM3U','#EXT-X-VERSION:3','#EXT-X-TARGETDURATION:1','#EXT-X-MEDIA-SEQUENCE:0','#EXT-X-PLAYLIST-TYPE:VOD',
  '#EXT-X-KEY:METHOD=AES-128,URI="' + ID + '.key",IV=0x00000000000000000000000000000000',
  '#EXTINF:0.3,','seg0.ts','#EXTINF:0.3,','seg1.ts','#EXTINF:0.3,','seg2.ts','#EXT-X-ENDLIST'
].join('\n');
fs.writeFileSync(path.join(FIXTURE, ID + '.m3u8'), playlistText);
fs.writeFileSync(path.join(FIXTURE, ID + '.key'), KEY);
for (let i = 0; i < 3; i++) { const iv = Buffer.alloc(16); iv.writeUInt32BE(i, 12); fs.writeFileSync(path.join(FIXTURE, `seg${i}.ts`), enc(makeTs(i), KEY, iv)); }

// --- 本地静态服务（供扩展 fetch 分片/播放列表） ---
const MIME = { '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t', '.key': 'application/octet-stream' };
const server = http.createServer((req, res) => {
  const base = req.url.split('?')[0];
  if (base === '/' || base === '') { res.writeHead(200, {'Content-Type':'text/html'}); res.end(fs.readFileSync(path.join(FIXTURE, 'page.html'))); return; }
  const f = path.join(FIXTURE, path.basename(base));
  try { const d = fs.readFileSync(f); res.writeHead(200, {'Content-Type': MIME[path.extname(f)] || 'application/octet-stream'}); res.end(d); }
  catch (e) { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
push('本地服务: ' + BASE);

// 页面：MAIN world 脚本让扩展 hook 上报 m3u8 + 2 个 TS（模拟真实嗅探，触发 content-main）
const pageHtml = `<!doctype html><html><head><meta charset="utf-8"><title>真实点击测试页面</title></head>
<body>
<h1>Media Sniffer 真实点击测试</h1>
<video width="320" height="180" controls></video>
<script>
(function(){
  // 模拟播放器用 fetch 拉 m3u8/ts —— 触发扩展 content-main 的 hook
  const base = location.origin;
  setTimeout(function(){
    fetch(base + '/' + '${ID}.m3u8').then(r=>r.text()).then(function(){ /* 触发 extension hook 上报 hls */ });
    fetch(base + '/seg0.ts');
    fetch(base + '/seg1.ts');
  }, 800);
})();
</script>
</body></html>`;
fs.writeFileSync(path.join(FIXTURE, 'page.html'), pageHtml);

const browser = await puppeteer.launch({
  protocolTimeout: 150000,
  executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: false,
  args: [
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    '--no-first-run', `--unsafely-treat-insecure-origin-as-secure=${BASE}`, '--allow-insecure-localhost',
  ],
});
try {
  let extId = null;
  for (let i = 0; i < 30; i++) {
    const w = browser.targets().filter((t) => t.type() === 'service_worker' && /background/.test(t.url()));
    if (w.length) { extId = w[0].url().split('/')[2]; break; }
    await new Promise((r) => setTimeout(r, 500));
  }
  push('ext=' + extId);

  // 打开本地页，让 hook 上报
  const page = await browser.newPage();
  page.on('console', (m) => push('[page-console] ' + m.text().slice(0, 200)));
  await page.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise((r) => setTimeout(r, 2500));
  const hookState = await page.evaluate(() => ({ main: !!window.__mediaSnifferHooked }));
  push('hook(main world) 注入: ' + hookState.main);
  // 查扩展后台是否嗅探到条目（直接用 debugDump）
  const diag = await browser.newPage();
  await diag.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: 'load', timeout: 30000 });
  const dump = await diag.evaluate(() => new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'debugDump' }, (r) => resolve(r));
  }));
  // 找到含 hls 条目的 tabId
  let targetTabId = null;
  for (const [tid, items] of Object.entries((dump && dump.dump) || {})) {
    if ((items || []).some((i) => i.cat === 'hls')) { targetTabId = Number(tid); break; }
  }
  await diag.close();
  push('后台嗅探 dump tabIds: ' + JSON.stringify(Object.keys((dump && dump.dump) || {})));
  push('含 hls 的 tabId: ' + targetTabId);
  if (targetTabId == null) throw new Error('后台未嗅探到 hls 条目');

  // 打开真实 popup，指定目标 tab
  const popup = await browser.newPage();
  popup.on('pageerror', (e) => push('[popup-pageerror] ' + String((e && e.stack) || e).slice(0, 300)));
  popup.on('console', (m) => { if (m.type() === 'error') push('[popup-console-error] ' + m.text().slice(0, 300)); });
  await popup.goto(`chrome-extension://${extId}/popup.html?tab=${targetTabId}`, { waitUntil: 'load', timeout: 30000 });
  await new Promise((r) => setTimeout(r, 1500));

  // 列出 popup 渲染条目
  const rendered = await popup.evaluate(() => {
    return [...document.querySelectorAll('#list .item')].map((card) => {
      const b = card.querySelector('.badge');
      const nm = card.querySelector('.filename');
      const btns = [...card.querySelectorAll('.actions button')].map((x) => ({ t: x.textContent, dis: x.disabled }));
      return { cat: b && b.textContent, name: nm && nm.textContent.slice(0, 40), btns };
    });
  });
  push('渲染条目: ' + JSON.stringify(rendered));

  // 找到 hls 条目并真实点击其「下载完整视频」
  const clickOut = await popup.evaluate(() => {
    const cards = [...document.querySelectorAll('#list .item')];
    const target = cards.find((c) => (c.querySelector('.badge')||{}).textContent === 'HLS');
    if (!target) return { ok: false, reason: 'no-hls-item', all: cards.length };
    const btn = [...target.querySelectorAll('.actions button')].find((x) => /完整视频|下载完整视频/.test(x.textContent));
    if (!btn) return { ok: false, reason: 'no-full-btn' };
    if (btn.disabled) return { ok: false, reason: 'btn-disabled' };
    const before = document.querySelector('#status').textContent;
    btn.click();
    return { ok: true, clickedText: btn.textContent, beforeStatus: before };
  });
  push('真实点击: ' + JSON.stringify(clickOut));

  // 观察后续状态
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const st = await popup.evaluate(() => {
      const s = document.querySelector('#status');
      return { status: s ? s.textContent : '', primaryDisabled: !!document.querySelector('.btn.primary:disabled') };
    });
    push(`  t+${(i+1)*1.5}s status=「${st.status}」 disabled=${st.primaryDisabled}`);
  }

  // downloads
  const dl = await popup.evaluate(() => new Promise((resolve) => {
    chrome.downloads.search({ limit: 5, orderBy: ['-startTime'] }, (items) => resolve((items||[]).map((i)=>({f:i.filename,st:i.state,b:i.bytesReceived,t:i.totalBytes}))));
  }));
  push('downloads: ' + JSON.stringify(dl));
} catch (e) {
  push('ERROR: ' + (e.stack || e.message).slice(0, 800));
} finally {
  await browser.close().catch(() => {});
  server.close();
  fs.writeFileSync('K:\\vibecoding\\media-sniffer\\test\\click-btn.json', JSON.stringify({ log, }, null, 2));
}
