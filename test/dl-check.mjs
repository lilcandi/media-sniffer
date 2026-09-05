// 检查最近一次真实下载的状态：downloadId 是否真的落盘成文件
import { createRequire } from 'module';
const require = createRequire('C:/Users/candi/.workbuddy/binaries/node/workspace/');
const puppeteer = require('puppeteer-core');
import fs from 'fs';
const EXT = 'K:\\vibecoding\\media-sniffer';
const LOG = [];
const push = (s) => { console.log(s); LOG.push(s); };

const browser = await puppeteer.launch({
  protocolTimeout: 150000,
  executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: false,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run'],
});

try {
  let extId = null;
  for (let i = 0; i < 30; i++) {
    const w = browser.targets().filter((t) => t.type() === 'service_worker' && /background/.test(t.url()));
    if (w.length) { extId = w[0].url().split('/')[2]; break; }
    await new Promise((r) => setTimeout(r, 500));
  }
  push('ext=' + extId);
  const ep = await browser.newPage();
  await ep.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: 'load', timeout: 30000 });
  await new Promise((r) => setTimeout(r, 1000));
  // 列出所有最近下载，看 state / error / bytes
  const items = await ep.evaluate(() => new Promise((resolve) => {
    chrome.downloads.search({ limit: 10 }, (ds) => resolve((ds || []).map((d) => ({
      id: d.id, state: d.state, error: d.error || null, filename: d.filename,
      bytes: d.bytesReceived, total: d.totalBytes, paused: d.paused, url: (d.url || '').slice(0, 40),
    }))));
  }));
  push('下载记录:');
  for (const it of items) push('  ' + JSON.stringify(it));
  const last = items[0];
  if (last) {
    push('最后一项 state=' + last.state + ' error=' + last.error + ' bytes=' + last.bytes + '/' + last.total);
    // 若 incomplete，再看 error
  }
  fs.writeFileSync('K:\\vibecoding\\media-sniffer\\test\\dl-check.json', JSON.stringify({ items, LOG }, null, 2));
} catch (e) {
  push('ERROR: ' + (e.stack || e.message).slice(0, 500));
} finally {
  await browser.close().catch(() => {});
}
