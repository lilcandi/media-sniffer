// 端到端：master playlist（含 #EXT-X-STREAM-INF 变体）下载合并测试
// 模拟真实站点 gkinowikiwik：master.m3u8 引用 2 个不同子域的变体 playlist，
// 变体 playlist 各自引用加密 TS 分片。验证 downloadM3u8Full 能正确走 master→variant→segments。
import { createRequire } from 'module';
const require = createRequire('C:/Users/candi/.workbuddy/binaries/node/workspace/');
const puppeteer = require('puppeteer-core');
const http = require('http');
const fs = require('fs');
const path = require('path');
import os from 'os';
import crypto from 'crypto';

const EXT = 'K:\\vibecoding\\media-sniffer';
const ROOT = 'K:\\vibecoding\\media-sniffer\\test\\fixture-master';
const LOG = [];
const push = (s) => { console.log(s); LOG.push(s); };

const KEY = crypto.randomBytes(16);
function makeTs(seq) {
  const buf = Buffer.alloc(188 * 6);
  for (let i = 0; i < 6; i++) { buf[i * 188] = 0x47; buf[i * 188 + 1] = 0x40; }
  buf.writeUInt32BE(seq, 4);
  return buf;
}
function enc(buf, key, iv) {
  const c = crypto.createCipheriv('aes-128-cbc', key, iv);
  return Buffer.concat([c.update(buf), c.final()]);
}
const ivOf = (seq) => { const b = Buffer.alloc(16); b.writeUInt32BE(seq, 12); return b; };

fs.mkdirSync(path.join(ROOT, 'a'), { recursive: true });
fs.mkdirSync(path.join(ROOT, 'b'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'key.bin'), KEY);

// variant A: 3 分片
const segA = [];
for (let i = 0; i < 3; i++) { const p = enc(makeTs(i), KEY, ivOf(i)); fs.writeFileSync(path.join(ROOT, 'a', 'seg' + i + '.ts'), p); segA.push(i); }
fs.writeFileSync(path.join(ROOT, 'a', 'index.m3u8'), [
  '#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:1', '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD',
  '#EXT-X-KEY:METHOD=AES-128,URI="../key.bin",IV=0x00000000000000000000000000000000',
  '#EXTINF:1.0,', 'seg0.ts', '#EXTINF:1.0,', 'seg1.ts', '#EXTINF:1.0,', 'seg2.ts', '#EXT-X-ENDLIST',
].join('\n'));
// variant B: 2 分片
for (let i = 0; i < 2; i++) { const p = enc(makeTs(10 + i), KEY, ivOf(10 + i)); fs.writeFileSync(path.join(ROOT, 'b', 'seg' + i + '.ts'), p); }
fs.writeFileSync(path.join(ROOT, 'b', 'index.m3u8'), [
  '#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:1', '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD',
  '#EXT-X-KEY:METHOD=AES-128,URI="../key.bin",IV=0x00000000000000000000000000000000',
  '#EXTINF:1.0,', 'seg0.ts', '#EXTINF:1.0,', 'seg1.ts', '#EXT-X-ENDLIST',
].join('\n'));

push('fixture 已准备');

// 服务：把 master 放在 http://127.0.0.1:PORT/master.m3u8，variants 用 <id>.m3u8（不同"域名"用不同端口模拟跨域）
const MIME = { '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t', '.bin': 'application/octet-stream' };
function serve(dir, rootRel) {
  return http.createServer((req, res) => {
    const base = req.url.split('?')[0];
    if (base === '/' || base === '') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html><body>master-fixture</body></html>'); return; }
    const f = path.join(ROOT, base.replace(/^\//, ''));
    try {
      const data = fs.readFileSync(f);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Access-Control-Allow-Origin': '*' });
      res.end(data);
    } catch (e) { res.writeHead(404); res.end('nf'); }
  });
}
const srvA = serve(ROOT); const srvB = serve(ROOT);
await new Promise((r) => srvA.listen(0, '127.0.0.1', r));
await new Promise((r) => srvB.listen(0, '127.0.0.1', r));
const BA = `http://127.0.0.1:${srvA.address().port}`;
const BB = `http://127.0.0.1:${srvB.address().port}`;
// master 引用两个变体：一个在本服务 A，一个在服务 B（模拟跨域变体）
const masterText = [
  '#EXTM3U', '#EXT-X-VERSION:3',
  '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360', BA + '/a/index.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=1280x720', BB + '/b/index.m3u8',
  '#EXT-X-ENDLIST',
].join('\n');
fs.writeFileSync(path.join(ROOT, 'master.m3u8'), masterText);
push('master=' + masterText.replace(/\n/g, ' | '));

const browser = await puppeteer.launch({
  protocolTimeout: 120000,
  executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: false,
  args: [
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run',
    `--unsafely-treat-insecure-origin-as-secure=${BA}`, `--unsafely-treat-insecure-origin-as-secure=${BB}`, '--allow-insecure-localhost',
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

  // 打开 master 所在页面（让 content script 注入到 A 域）
  const page = await browser.newPage();
  await page.goto(BA + '/', { waitUntil: 'load' });
  await new Promise((r) => setTimeout(r, 1000));

  const tabId = await new Promise((resolve) => {
    const ep = browser.newPage();
    ep.then(async (p) => {
      await p.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: 'load', timeout: 30000 });
      const tid = await p.evaluate(() => new Promise((res) => {
        chrome.tabs.query({}, (ts) => { const t = (ts || []).find((x) => x.url && x.url.indexOf('127.0.0.1') >= 0); res(t ? t.id : null); });
      }));
      await p.close(); resolve(tid);
    });
  });
  push('tabId=' + tabId);

  // 直接调 downloadM3u8 传 master URL
  const ep2 = await browser.newPage();
  await ep2.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: 'load', timeout: 30000 });
  const masterUrl = BA + '/master.m3u8';
  const t0 = Date.now();
  const ret = await ep2.evaluate(({ u, tid }) => new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'downloadM3u8', url: u, tabId: tid, title: '主播放列表测试' }, (r) => resolve(r));
  }), { u: masterUrl, tid: tabId });
  push(`[master] 直接返回用时${Date.now() - t0}ms: ` + JSON.stringify(ret).slice(0, 300));

  // long-poll 兜底
  if (!(ret && (ret.name || ret.error))) {
    const last = await ep2.evaluate((tid) => new Promise((resolve) => {
      let i = 0; const tick = () => {
        chrome.runtime.sendMessage({ type: 'getLastDownload', tabId: tid }, (r) => {
          const l = r && r.last;
          if (l && (l.name || l.error)) return resolve(l);
          if (++i >= 25) return resolve(null);
          setTimeout(tick, 200);
        });
      }; tick();
    }), tabId);
    push('[master] long-poll: ' + JSON.stringify(last).slice(0, 300));
  }
} catch (e) {
  push('ERROR: ' + (e.stack || e.message).slice(0, 500));
} finally {
  await browser.close().catch(() => {});
  srvA.close(); srvB.close();
  fs.writeFileSync('K:\\vibecoding\\media-sniffer\\test\\e2e-master.mjs.json', JSON.stringify({ log: LOG }, null, 2));
}
