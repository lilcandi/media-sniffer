// 真实站点诊断：抓取嗅探到的 m3u8 入口内容，判断 master/变体/分片结构 + 触发实际下载
import { createRequire } from 'module';
const require = createRequire('C:/Users/candi/.workbuddy/binaries/node/workspace/');
const puppeteer = require('puppeteer-core');
import fs from 'fs';

const EXT = 'K:\\vibecoding\\media-sniffer';
const TARGET = 'https://gkinowikiwik.ubhoymtvd.cc/archives/214027/';
const LOG = [];
const push = (s) => { console.log(s); LOG.push(s); };

const browser = await puppeteer.launch({
  protocolTimeout: 150000,
  executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: false,
  args: [
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    '--autoplay-policy=no-user-gesture-required', '--no-first-run', '--window-size=1280,900',
  ],
});

async function swEval(extId, fn, args) {
  const ep = await browser.newPage();
  await ep.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: 'load', timeout: 30000 });
  const r = await ep.evaluate(fn, args);
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
  // 等跳转稳定
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const cur = page.url(); const next = await page.evaluate(() => location.href).catch(() => cur);
    if (next === cur) break;
  }
  push('[1] 页面稳定: ' + page.url());

  // 等几秒让嗅探爬取 m3u8 入口
  await new Promise((r) => setTimeout(r, 8000));

  // 拿媒体条目
  const media = await swEval(extId, () => new Promise((resolve) => {
    chrome.tabs.query({}, (tabs) => {
      const tab = (tabs || []).find((t) => /gkinowikiwik|lwvldygi|ubhoymtvd/.test(t.url || ''));
      if (!tab) return resolve(null);
      chrome.runtime.sendMessage({ type: 'get', tabId: tab.id }, (r) => resolve({ tabId: tab.id, title: tab.title, items: (r && r.items) || [] }));
    });
  }));
  if (!media) { push('❌ 没找到目标 tab'); process.exit(0); }
  const hls = (media.items || []).filter((i) => i.cat === 'hls' && !/^blob:/.test(i.url));
  const seg = (media.items || []).filter((i) => i.cat === 'segment');
  push('[2] tabId=' + media.tabId + ' title=' + media.title);
  push('  hls入口 ' + hls.length + ' 条: ' + hls.map((h) => h.url.slice(0, 130)).join('\n  '));
  push('  segment ' + seg.length + ' 条(前4): ' + seg.slice(0, 4).map((s) => s.url.slice(0, 120)).join('\n  '));

  // 选第一个 hls 入口，抓内容
  const chosen = hls[0];
  if (!chosen) { push('❌ 无 hls 入口'); process.exit(0); }
  const m3u8url = chosen.url;
  push('[3] 抓取入口: ' + m3u8url.slice(0, 200));

  // 用 SW 的 swFetchDiag 逻辑抓内容（带 Referer 从 tab 内 fetch 更接近）
  // 先在页面上下文用 fetch 抓（带页面 cookie/referer）
  const rawText = await page.evaluate(async (u) => {
    try {
      const r = await fetch(u, { credentials: 'include' });
      if (!r.ok) return 'HTTP ' + r.status;
      return await r.text();
    } catch (e) { return 'EXC ' + (e && e.message); }
  }, m3u8url).catch((e) => 'EVAL ' + e.message);
  push('[4] 页面fetch返回前500字:');
  push((rawText || '').slice(0, 500));
  const lines = (rawText || '').split('\n');
  push('  行数=' + lines.length);
  const hasStreamInf = lines.some((l) => l.includes('#EXT-X-STREAM-INF'));
  const hasKey = lines.some((l) => l.includes('#EXT-X-KEY'));
  const hasExtInf = lines.some((l) => l.startsWith('#EXTINF'));
  push('  master(STREAM-INF)=' + hasStreamInf + ' KEY=' + hasKey + ' EXTINF=' + hasExtInf);
  // 打印前 30 行非注释 / 关键行
  push('  前20行:');
  lines.slice(0, 20).forEach((l, i) => { if (l.trim()) push('    ' + l.slice(0, 140)); });
  // 提取 STREAM-INF 后的变体 URL
  const variants = [];
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i].includes('#EXT-X-STREAM-INF') && lines[i + 1] && /\.m3u8/i.test(lines[i + 1])) variants.push(lines[i + 1].trim());
  }
  const keys = [];
  for (const l of lines) { const m = l.match(/URI="([^"]+)"/); if (m && l.includes('#EXT-X-KEY')) keys.push(m[1]); }
  push('  变体URL: ' + JSON.stringify(variants));
  push('  KEY URI: ' + JSON.stringify(keys));

  // 尝试下载第一个 hls
  push('[5] 触发下载 master=' + m3u8url.slice(0, 150));
  const res = await swEval(extId, ({ u, tid, title }) => new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'downloadM3u8', url: u, tabId: tid, title }, (r) => resolve(r));
  }), { u: m3u8url, tid: media.tabId, title: media.title });
  push('  下载返回: ' + JSON.stringify(res).slice(0, 300));
  if (!(res && (res.name || res.error))) {
    const last = await swEval(extId, (tid) => new Promise((resolve) => {
      let i = 0; const tick = () => {
        chrome.runtime.sendMessage({ type: 'getLastDownload', tabId: tid }, (r) => {
          const l = r && r.last;
          if (l && (l.name || l.error)) return resolve(l);
          if (++i >= 30) return resolve(null);
          setTimeout(tick, 300);
        });
      }; tick();
    }), media.tabId);
    push('  long-poll: ' + JSON.stringify(last).slice(0, 300));
  }

  fs.writeFileSync('K:\\vibecoding\\media-sniffer\\test\\real-diag.json', JSON.stringify({ LOG, media, hls, seg, rawText: (rawText || '').slice(0, 2000), variants, keys }, null, 2));
} catch (e) {
  push('ERROR: ' + (e.stack || e.message).slice(0, 600));
} finally {
  await browser.close().catch(() => {});
}
