// 深度诊断：CDP 抓取页面全部网络请求 + 播放器行为
import { createRequire } from 'module';
const require = createRequire('C:/Users/candi/.workbuddy/binaries/node/workspace/');
const puppeteer = require('puppeteer-core');
import fs from 'fs';

const EXT = 'K:\\vibecoding\\media-sniffer';
const TARGET = 'https://gkinowikiwik.ubhoymtvd.cc/archives/214027/';
const OUT = 'K:\\vibecoding\\media-sniffer\\test\\diag.json';

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: false,
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
  let extId = null;
  for (let i = 0; i < 30; i++) {
    const w = browser.targets().filter((t) => t.type() === 'service_worker' && /background/.test(t.url()));
    if (w.length) { extId = w[0].url().split('/')[2]; break; }
    await new Promise((r) => setTimeout(r, 500));
  }
  push('[1] ext=' + extId);

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 2000 });

  // CDP 全量网络监听
  const cdp = await page.target().createCDPSession();
  await cdp.send('Network.enable');
  const reqs = [];
  cdp.on('Network.requestWillBeSent', (e) => {
    reqs.push({ url: e.request.url, type: e.type, ts: e.timestamp });
  });
  cdp.on('Network.responseReceived', (e) => {
    const r = reqs.find((x) => x.url === e.response.url);
    if (r) r.mime = e.response.mimeType;
  });

  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => push('goto: ' + e.message.slice(0, 100)));
  // 等待重定向稳定
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const cur = page.url();
    const next = await page.evaluate(() => location.href).catch(() => cur);
    if (next === cur) break;
  }
  push('[2] 稳定后 URL: ' + page.url());

  // 检查 hook 是否注入成功
  const hookState = await page.evaluate(() => ({
    mainHooked: !!window.__mediaSnifferHooked,
    isoHooked: !!window.__mediaSnifferInjected,
  }));
  push('[3] hook 注入状态: ' + JSON.stringify(hookState));

  // 播放器信息
  const playerInfo = await page.evaluate(() => {
    const v = document.querySelector('video');
    const out = { video: !!v, src: v && (v.currentSrc || v.src || '').slice(0, 100) };
    // 找播放器配置
    const scripts = [...document.querySelectorAll('script')].map((s) => s.src).filter(Boolean);
    out.playerScripts = scripts.filter((s) => /player|hls|dplayer|artplayer|video|jw|ckplayer|xgplayer/i.test(s)).slice(0, 10);
    return out;
  });
  push('[4] player: ' + JSON.stringify(playerInfo));

  // 滚动到视频并点击
  await page.evaluate(() => {
    const v = document.querySelector('video');
    if (v) v.scrollIntoView({ block: 'center' });
  });
  await new Promise((r) => setTimeout(r, 2000));
  const rect = await page.evaluate(() => {
    const v = document.querySelector('video');
    const r = v.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height, paused: v.paused };
  });
  push('[5] video rect: ' + JSON.stringify(rect));
  if (rect.w > 50) {
    await page.mouse.click(rect.x, rect.y);
    push('[6] 已点击视频');
  }
  await new Promise((r) => setTimeout(r, 20000));

  // 分类网络请求
  const mediaRe = /m3u8|mpd|\.ts(\?|$)|\.mp4|\.mp3|video|audio|mpegurl|octet-stream|segment/i;
  const interesting = reqs.filter((r) => mediaRe.test(r.url) || /video|audio|mpegurl|octet/.test(r.mime || ''));
  push('[7] 全部请求数: ' + reqs.length + ', 媒体相关: ' + interesting.length);
  for (const r of interesting.slice(0, 40)) {
    push('  ' + (r.type || '?') + ' | ' + (r.mime || '') + ' | ' + r.url.slice(0, 220));
  }

  // MSE 缓冲信息
  const buf = await page.evaluate(() => {
    const v = document.querySelector('video');
    if (!v) return 'no video';
    try {
      return { readyState: v.readyState, paused: v.paused, err: v.error && v.error.message, dur: v.duration };
    } catch (e) { return String(e); }
  });
  push('[8] video 状态: ' + JSON.stringify(buf));

  // 扩展嗅探结果
  const extPage = await browser.newPage();
  await extPage.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: 'load' });
  const extDump = await extPage.evaluate(() => new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'debugDump' }, (r) => resolve(r));
  }));
  await extPage.close();
  const media = Object.values(extDump.dump || {}).flat().filter((i) => ['hls', 'dash', 'segment', 'video', 'audio'].includes(i.cat));
  push('[9] 扩展嗅探到媒体: ' + media.length);
  for (const m of media.slice(0, 20)) push('  ' + m.cat + '|' + m.from + '|' + m.url.slice(0, 200));

  fs.writeFileSync(OUT, JSON.stringify({ interesting, reqsTotal: reqs.length, media, extDump, log }, null, 2));
  push('[10] 已写入 ' + OUT);
} catch (e) {
  push('ERROR: ' + (e.stack || e.message).slice(0, 500));
  fs.writeFileSync(OUT, JSON.stringify({ error: String(e), log }, null, 2));
} finally {
  await browser.close().catch(() => {});
}
