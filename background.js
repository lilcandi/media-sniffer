// Media Sniffer - Background Service Worker (嗅探 / 存储 / 扫描)
// 职责：
//   1) webRequest 嗅探媒体资源（扩展名 + Content-Type 双重识别）
//   2) 汇集 DOM/hook 上报的资源，按标签页隔离存储
//   3) 触发页面增量扫描
// 注意：m3u8 抓取/解密/合并/落盘 已不在本 SW 执行 —— 改由「媒体下载合并」扩展页
//       downloader.html 在页面上下文完成（URL.createObjectURL 可用、fetch 跨域、页面长驻不被回收），
//       规避 MV3 Service Worker 被回收导致大视频下载中断的问题。

const MAX_PER_TAB = 600;

// ---------------- 分类识别 ----------------
const EXT_RULES = [
  { cat: 'hls', re: /\.(m3u8)(\?|#|$)/i },
  { cat: 'dash', re: /\.(mpd)(\?|#|$)/i },
  { cat: 'video', re: /\.(mp4|m4v|webm|mkv|flv|avi|mov|wmv|3gp|ogv|mpg|mpeg)(\?|#|$)/i },
  { cat: 'audio', re: /\.(mp3|m4a|aac|wav|ogg|oga|opus|flac|wma|amr|mid|midi)(\?|#|$)/i },
  { cat: 'image', re: /\.(jpe?g|png|gif|webp|bmp|svg|ico|avif|tiff?)(\?|#|$)/i },
];
const MIME_RULES = [
  { cat: 'hls', re: /^(application\/vnd\.apple\.mpegurl|application\/x-mpegurl|audio\/mpegurl)/i },
  { cat: 'dash', re: /^application\/dash\+xml/i },
  { cat: 'video', re: /^video\//i },
  { cat: 'audio', re: /^audio\//i },
  { cat: 'image', re: /^image\//i },
];
const NOISE_IMAGE = /\.(sprite|blank|spacer|1x1|pixel|tracking)([^a-z0-9]|$)/i;
const RE_SEGMENT = /\.ts(\?|#|$)/i;

function categorize(url, mime) {
  const lower = url.toLowerCase();
  if (/m3u8/.test(lower) && !/\.(js|css|html?|json|php)(\?|#|$)/i.test(lower)) return 'hls';
  if (/\.mpd(\?|#|$)/.test(lower)) return 'dash';
  for (const r of EXT_RULES) if (r.re.test(url)) return r.cat;
  if (RE_SEGMENT.test(lower)) return 'segment';
  if (mime) {
    if (/mpegurl/i.test(mime)) return 'hls';
    for (const r of MIME_RULES) if (r.re.test(mime)) return r.cat;
    if (/octet-stream/i.test(mime) && RE_SEGMENT.test(lower)) return 'segment';
  }
  return null;
}

function filenameOf(url) {
  try {
    const u = new URL(url);
    return decodeURIComponent(u.pathname.split('/').pop() || '') || u.hostname;
  } catch (e) { return url.slice(0, 80); }
}

// ---------------- 存储（内存 + storage.session 持久化）----------------
const tabs = new Map();
let persistTimer = null;

function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    const dump = {};
    for (const [tabId, tab] of tabs) dump[tabId] = tab.order.map((url) => tab.items.get(url));
    chrome.storage.session.set({ mediaSniffer: dump }).catch(() => {});
  }, 400);
}

function restore() {
  chrome.storage.session.get('mediaSniffer').then((res) => {
    const dump = res.mediaSniffer;
    if (!dump) return;
    for (const tabId of Object.keys(dump)) {
      const tab = { items: new Map(), order: [] };
      for (const item of dump[tabId] || []) { tab.items.set(item.url, item); tab.order.push(item.url); }
      tabs.set(Number(tabId), tab);
    }
  }).catch(() => {});
}
restore();

function getTab(tabId) {
  let tab = tabs.get(tabId);
  if (!tab) { tab = { items: new Map(), order: [] }; tabs.set(tabId, tab); }
  return tab;
}

function clearTab(tabId) { tabs.delete(tabId); persist(); }

function addItem(tabId, item) {
  if (!item || !item.url) return false;
  if (!/^https?:/i.test(item.url)) return false;
  if (item.cat === 'image' && NOISE_IMAGE.test(item.url)) return false;
  const tab = getTab(tabId);
  if (tab.items.has(item.url)) {
    const old = tab.items.get(item.url);
    if (!old.size && item.size) { old.size = item.size; persist(); }
    return false;
  }
  tab.items.set(item.url, item);
  tab.order.push(item.url);
  if (tab.order.length > MAX_PER_TAB) {
    const evictIdx = tab.order.findIndex((u) => tab.items.get(u).cat === 'image');
    const idx = evictIdx >= 0 ? evictIdx : 0;
    tab.items.delete(tab.order[idx]);
    tab.order.splice(idx, 1);
  }
  persist();
  return true;
}

// ---------------- webRequest 监听 ----------------
chrome.webRequest.onCompleted.addListener((details) => {
  if (details.tabId < 0) return;
  let mime = '', size = null;
  for (const h of details.responseHeaders || []) {
    const name = h.name.toLowerCase();
    if (name === 'content-type') mime = (h.value || '').split(';')[0].trim();
    else if (name === 'content-length') size = parseInt(h.value, 10) || null;
  }
  const cat = categorize(details.url, mime);
  if (!cat) return;
  addItem(details.tabId, {
    url: details.url, cat, mime, size,
    filename: filenameOf(details.url), from: 'network', time: Date.now(),
  });
}, { urls: ['<all_urls>'] }, ['responseHeaders']);

// ---------------- 标签页导航清理 + origin 记录 ----------------
const tabOrigins = new Map(); // tabId -> { origin, referer }，供下载页获取防盗链 referer
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url && /^https?:/i.test(changeInfo.url)) {
    // 记录触发页 URL，供下载页防盗链重试使用（经 get 消息返回）
    try { tabOrigins.set(tabId, { origin: new URL(changeInfo.url).origin, referer: changeInfo.url }); } catch (e) {}
  }
  // 主文档 URL 变化（跳转/刷新起始）时清空旧嗅探
  if (changeInfo.status === 'loading' && changeInfo.url !== undefined) {
    const cur = tabs.get(tabId);
    if (cur && cur.order.length) clearTab(tabId);
  }
});
chrome.tabs.onRemoved.addListener((tabId) => { clearTab(tabId); tabOrigins.delete(tabId); });

// ---------------- 消息处理 ----------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // content script 上报 DOM 扫描结果
  if (msg && msg.type === 'addItems') {
    const tabId = sender.tab ? sender.tab.id : null;
    if (tabId != null && Array.isArray(msg.items)) {
      let added = 0;
      for (const item of msg.items) if (addItem(tabId, { ...item, from: item.from || 'dom', time: item.time || Date.now() })) added++;
      sendResponse({ ok: true, added });
    } else sendResponse({ ok: false });
    return true;
  }
  // popup 获取资源（附 origin/referer 供下载页防盗链）
  if (msg && msg.type === 'get' && msg.tabId != null) {
    const tab = tabs.get(msg.tabId);
    const origin = tabOrigins.get(msg.tabId) || { origin: '', referer: '' };
    sendResponse({ ok: true, items: tab ? tab.order.map((u) => tab.items.get(u)) : [], pageUrl: origin.referer });
    return true;
  }
  // popup 清空
  if (msg && msg.type === 'clear' && msg.tabId != null) {
    clearTab(msg.tabId);
    sendResponse({ ok: true });
    return true;
  }
  // popup 触发扫描
  if (msg && msg.type === 'scan' && msg.tabId != null) {
    chrome.scripting.executeScript({
      target: { tabId: msg.tabId, allFrames: true },
      files: ['content-scan.js'],
    }).then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  // 下载页/调试：拿某个 tab 的触发页 URL（防盗链 referer）
  if (msg && msg.type === 'getPageUrl' && msg.tabId != null) {
    const origin = tabOrigins.get(msg.tabId) || {};
    sendResponse({ ok: true, pageUrl: origin.referer || '' });
    return true;
  }
  sendResponse({ ok: false });
  return true;
});
