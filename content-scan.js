// Media Sniffer - 手动扫描脚本（由 popup 通过 chrome.scripting 注入执行）
// 依赖 content.js 已注入（manifest 自动注入；若被 CSP 拦截则此脚本独立工作）
(function () {
  'use strict';

  function abs(u) {
    try { return new URL(u, location.href).href; } catch (e) { return null; }
  }

  const items = [];
  const seen = new Set();

  function push(url, cat) {
    if (!url || !/^https?:/i.test(url) || seen.has(url)) return;
    seen.add(url);
    let filename = url;
    try {
      filename = decodeURIComponent(new URL(url).pathname.split('/').pop() || '') || url;
    } catch (e) {}
    items.push({ url, cat, from: 'scan', filename });
  }

  // DOM 标签
  for (const el of document.querySelectorAll('img, video, audio, source, track, embed')) {
    const src = el.currentSrc || el.src || el.getAttribute('src');
    if (src) {
      const a = abs(src);
      if (a) push(a, guessCat(src, el.tagName));
    }
    if (el.poster) {
      const a = abs(el.poster);
      if (a) push(a, 'image');
    }
  }

  // 页面源码
  const RE = /https?:\/\/[^\s"'<>()\\]+?\.(m3u8|mpd|mp4|m4v|webm|mkv|flv|mp3|m4a|aac|wav|ogg|opus|flac|jpe?g|png|gif|webp)(\?[^\s"'<>()\\]*)?/gi;
  const html = document.documentElement.outerHTML;
  let m;
  while ((m = RE.exec(html)) !== null) {
    const ext = m[1].toLowerCase();
    let cat = 'video';
    if (ext === 'm3u8') cat = 'hls';
    else if (ext === 'mpd') cat = 'dash';
    else if (['mp3', 'm4a', 'aac', 'wav', 'ogg', 'opus', 'flac'].includes(ext)) cat = 'audio';
    else if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) cat = 'image';
    push(m[0], cat);
  }

  function guessCat(src, tag) {
    const s = (src || '').toLowerCase();
    if (/\.m3u8(\?|#|$)/.test(s)) return 'hls';
    if (/\.mpd(\?|#|$)/.test(s)) return 'dash';
    if (tag === 'VIDEO' || /\.(mp4|webm|mkv|mov|flv|avi|m4v)(\?|#|$)/.test(s)) return 'video';
    if (tag === 'AUDIO' || /\.(mp3|m4a|aac|wav|ogg|opus|flac)(\?|#|$)/.test(s)) return 'audio';
    return 'image';
  }

  if (items.length) {
    try {
      chrome.runtime.sendMessage({ type: 'addItems', items }, () => void chrome.runtime.lastError);
    } catch (e) {}
  }
  return items.length;
})();
