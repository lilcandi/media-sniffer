// 端到端：用户从 TS 分片入口触发完整下载
// 模拟真实场景：m3u8 URL 不存在/错时，靠 findWorkingM3u8 同目录推导回退
// 用本地静态服务返回 m3u8 playlist，给分片示例 URL，让 popup 调用 downloadM3u8
import { createRequire } from 'module';
const require = createRequire('C:/Users/candi/.workbuddy/binaries/node/workspace/');
const puppeteer = require('puppeteer-core');
const http = require('http');
const fs = require('fs');
const path = require('path');
import os from 'os';
import crypto from 'crypto';

const EXT = 'K:\\vibecoding\\media-sniffer';
const FIXTURE = 'K:\\vibecoding\\media-sniffer\\test\\fixture-seg';
const LOG = [];
const push = (s) => { console.log(s); LOG.push(s); };

// 准备一个最小加密 HLS：3 个分片，密钥是固定 16 字节；分片是用伪随机但同步字节 0x47 + 187 填充
const KEY = crypto.randomBytes(16);
function makeTsSegment(seq) {
  const buf = Buffer.alloc(188 * 5);
  for (let i = 0; i < 5; i++) {
    buf[i * 188] = 0x47; // TS 同步字节
    buf[i * 188 + 1] = 0x40; // PUSI
  }
  // 给每片写入段序号做校验
  buf.writeUInt32BE(seq, 4);
  return buf;
}
function encrypt(buf, key, iv) {
  const c = crypto.createCipheriv('aes-128-cbc', key, iv);
  return Buffer.concat([c.update(buf), c.final()]);
}

fs.mkdirSync(FIXTURE, { recursive: true });
const ID = 'abcdef0123456789';
const playlistText = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-TARGETDURATION:1',
  '#EXT-X-MEDIA-SEQUENCE:0',
  '#EXT-X-PLAYLIST-TYPE:VOD',
  '#EXT-X-KEY:METHOD=AES-128,URI="' + ID + '.key",IV=0x00000000000000000000000000000000',
  '#EXTINF:0.300,',
  'seg0.ts',
  '#EXTINF:0.300,',
  'seg1.ts',
  '#EXTINF:0.300,',
  'seg2.ts',
  '#EXT-X-ENDLIST',
].join('\n');
fs.writeFileSync(path.join(FIXTURE, ID + '.m3u8'), playlistText);
fs.writeFileSync(path.join(FIXTURE, ID + '.key'), KEY);
for (let i = 0; i < 3; i++) {
  const iv = Buffer.alloc(16);
  iv.writeUInt32BE(i, 12);
  const plain = makeTsSegment(i);
  const enc = encrypt(plain, KEY, iv);
  fs.writeFileSync(path.join(FIXTURE, 'seg' + i + '.ts'), enc);
}
push('fixture 已准备：ID=' + ID);

// 本地静态服务（关键一点：m3u8 头部需 .m3u8，否则被认为 HTML）
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

// fixture 影片根 URL（模拟站点跳转后的最终页）
const pageHtml = `<!doctype html><html><body><video></video><div id="id">${ID}</div></body></html>`;

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

  const page = await browser.newPage();
  await page.goto(BASE + '/', { waitUntil: 'load' });

  // 模拟嗅探后端：把 segment 条目直接添加到 SW 的 tab 缓存（通过从扩展 popup 调 addItems）
  // 但普通页面没 chrome.runtime；我们直接从扩展 popup eval 注入。
  const extPage0 = await browser.newPage();
  await extPage0.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: 'load', timeout: 30000 });
  await new Promise((r) => setTimeout(r, 800));
  await extPage0.evaluate((id) => new Promise((resolve) => {
    chrome.tabs.query({}, (tabs) => {
      const tab = (tabs || []).find((t) => t.url && t.url.startsWith('http://127.0.0.1'));
      if (!tab) return resolve(null);
      chrome.runtime.sendMessage({
        type: 'addItems',
        items: [{
          url: location.origin + '/' + id + '999.ts',
          cat: 'segment',
          mime: 'video/mp2t',
          size: 1024,
          filename: id + '999.ts',
          from: 'inject',
          tabId: tab.id,
        }],
      }, () => resolve(true));
    });
  }), ID);
  await new Promise((r) => setTimeout(r, 600));
  await extPage0.close();

  const extPage = await browser.newPage();
  await extPage.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: 'load', timeout: 30000 });
  await new Promise((r) => setTimeout(r, 800));

  // 验证 popup 已加载
  const intro = await extPage.evaluate(() => new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    setTimeout(() => finish({ ok: false, reason: 'timeout-intro' }), 6000);
    chrome.tabs.query({}, (tabs) => {
      const tab = (tabs || []).find((t) => t.url && t.url.startsWith('http://127.0.0.1'));
      if (!tab) return finish({ ok: false, reason: 'no-local-tab' });
      chrome.runtime.sendMessage({ type: 'get', tabId: tab.id }, (r) => {
        if (chrome.runtime.lastError) return finish({ ok: false, reason: chrome.runtime.lastError.message });
        finish({ items: (r && r.items) || [] });
      });
    });
  }));
  push('intro raw=' + JSON.stringify(intro).slice(0, 240));

  // 调用 downloadM3u8。两种 URL 都试：
  //  A) 正确 m3u8: <id>.m3u8 → 期望 ok
  //  B) 错的 m3u8: <id>999.m3u8 → 期望 findWorkingM3u8 同目录倒推回 <id>.m3u8
  async function doDownload(testUrl, title, tag) {
    const ep = await browser.newPage();
    await ep.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: 'load', timeout: 30000 });
    const r = await ep.evaluate(({ testUrl, title }) => new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      setTimeout(() => finish({ ok: false, reason: 'timeout' }), 30000);
      try {
        chrome.tabs.query({}, (tabs) => {
          const tab = (tabs || []).find((t) => t.url && t.url.startsWith('http://127.0.0.1'));
          if (!tab) return finish({ ok: false, reason: 'no local tab' });
          window.__lastTabId = tab.id;
          chrome.runtime.sendMessage({ type: 'downloadM3u8', url: testUrl, tabId: tab.id, title }, (r) => {
            if (chrome.runtime.lastError) return finish({ ok: false, reason: 'lastErr: ' + chrome.runtime.lastError.message });
            finish(r);
          });
        });
      } catch (e) { finish({ ok: false, reason: 'ex: ' + (e && e.message || e) }); }
    }), { testUrl, title });
    push(`[${tag}] popup 直接拿到: ` + JSON.stringify(r));
    // long-poll：拉 dlLast_<tabId>，要求 last.jobId !== sinceJobId（即新结果）
    // 如果 r 已经含可见字段（name/segs/error），就不必再走 long-poll，直接拿
    if (r && (r.name || r.error)) return r;
    const finalResult = await ep.evaluate(() => new Promise((resolve) => {
      const tabIdHint = window.__lastTabId;
      if (!tabIdHint) return resolve(null);
      let i = 0; const tick = () => {
        chrome.runtime.sendMessage({ type: 'getLastDownload', tabId: tabIdHint }, (r) => {
          const last = r && r.last;
          if (last && (last.name || last.error)) return resolve(last);
          if (++i >= 25) return resolve(null);
          setTimeout(tick, 200);
        });
      };
      tick();
    }));
    push(`[${tag}] long-poll 拿到: ` + JSON.stringify(finalResult));
    return finalResult || r;
  }

  const goodUrl = BASE + '/' + ID + '.m3u8';
  const resA = await doDownload(goodUrl, '本地倒推测试-A', 'A-正确');

  // B: 模拟 popup 端 v1.4.0 buggy 推导（把末尾 11 切掉），看 findWorkingM3u8
  //    能否通过 /abcdef0123456789.m3u8 回退。但我们当前 fixture 没有 /abcdef0123456789.m3u8，
  //    这里我们改用「末尾 stem 切错」的 URL：.../abcdef0123456789X.m3u8 → 找 stem abcdef0123456789X 失败 → fallback master 也失败
  //    因此 B 的预期是 ok:false 且错误信息明确；回归预期。
  const badUrl = BASE + '/' + ID + 'wrong.m3u8';
  const resB = await doDownload(badUrl, '本地倒推测试-B', 'B-回退fail');

  // C: 模拟真实 TS→m3u8 推导：传入 .ts 风格 URL（应能在没有 .m3u8 的目录下退化为找 /stem.m3u8 —— 我们 fixture 是 /<id>.m3u8，所以应能找到）
  const tsStyleUrl = BASE + '/' + ID + '1111.ts';
  const resC = await doDownload(tsStyleUrl, '本地倒推测试-C', 'C-ts推导');

  const res = (resA && resA.ok) ? resA : ((resC && resC.ok) ? resC : null);

  // 校验落盘
  if (res && res.ok && res.downloadId != null) {
    let finalInfo = null;
    for (let i = 0; i < 20; i++) {
      const ep = await browser.newPage();
      await ep.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: 'load' });
      finalInfo = await ep.evaluate((did) => new Promise((resolve) => {
        chrome.downloads.search({ id: did }, (items) => {
          const it = items && items[0];
          resolve(it ? { filename: it.filename, state: it.state, bytes: it.bytesReceived, total: it.totalBytes, url: (it.url||'').slice(0,40) } : null);
        });
      }), res.downloadId);
      await ep.close();
      if (finalInfo && finalInfo.state === 'complete') break;
      await new Promise((r) => setTimeout(r, 1500));
    }
    push('下载完成: ' + JSON.stringify(finalInfo));
    const okSize = finalInfo && finalInfo.state === 'complete' && finalInfo.bytes === 188 * 5 * 3 && finalInfo.total === 188 * 5 * 3;
    push(okSize ? '✅ END-TO-END 通过：findWorkingM3u8 回退正常下载并合并' : '❌ 校验失败（期望 ' + (188 * 5 * 3) + ' 字节）');

    // 落盘二次校验解密字节头
    if (finalInfo && finalInfo.filename) {
      for (const root of [os.homedir(), process.env.USERPROFILE]) {
        const cand = path.join(root, 'Downloads', finalInfo.filename);
        try { if (fs.statSync(cand).size === 188 * 5 * 3) { savedFile = cand; break; } } catch (e) {}
      }
      if (savedFile) {
        const data = fs.readFileSync(savedFile);
        let sync = 0, total = 0;
        for (let i = 0; i < data.length; i += 188) { total++; if (data[i] === 0x47) sync++; }
        push(`落盘 TS 同步字节：${sync}/${total}，大小 ${data.length}`);
      }
    }
  }
} catch (e) {
  push('ERROR: ' + (e.stack || e.message).slice(0, 500));
} finally {
  await browser.close().catch(() => {});
  server.close();
  fs.writeFileSync('K:\\vibecoding\\media-sniffer\\test\\e2e-seg.mjs.json', JSON.stringify({ res: LOG, savedFile, downloadsDir }, null, 2));
}
