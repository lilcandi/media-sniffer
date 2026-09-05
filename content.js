// Media Sniffer - Content Script
// 1) DOM 媒体标签扫描（含 MutationObserver 监听动态插入）
// 2) 页面源码正则嗅探 m3u8/mpd/mp4 等直链
// 3) performance resource entries 补充

(function () {
  'use strict';
  if (window.__mediaSnifferInjected) return;
  window.__mediaSnifferInjected = true;

  const seen = new Set();
  const pending = [];

  function send(items) {
    try {
      chrome.runtime.sendMessage({ type: 'addItems', items }, () => void chrome.runtime.lastError);
    } catch (e) { /* 上下文失效，忽略 */ }
  }

  function push(url, cat, from) {
    if (!url || typeof url !== 'string') return;
    url = url.trim();
    if (!/^https?:/i.test(url)) return;
    const key = cat + '|' + url;
    if (seen.has(key)) return;
    seen.add(key);
    pending.push({ url, cat, from, filename: filenameOf(url) });
  }

  function filenameOf(url) {
    try {
      const u = new URL(url);
      return decodeURIComponent(u.pathname.split('/').pop() || '') || u.hostname;
    } catch (e) { return url.slice(0, 80); }
  }

  function abs(u) {
    try { return new URL(u, location.href).href; } catch (e) { return null; }
  }

  function flush() {
    if (!pending.length) return;
    send(pending.splice(0, pending.length));
  }

  // ---------- 1. DOM 扫描 ----------
  function scanDom() {
    const nodes = document.querySelectorAll('img, video, audio, source, track, embed');
    for (const el of nodes) {
      const src = el.currentSrc || el.src || el.getAttribute('src');
      if (src) {
        const a = abs(src);
        if (a) push(a, guessCat(src, el.tagName), 'dom');
      }
      // srcset
      if (el.srcset) {
        for (const part of el.srcset.split(',')) {
          const u = part.trim().split(/\s+/)[0];
          const a = abs(u);
          if (a) push(a, 'image', 'dom');
        }
      }
      // poster
      if (el.tagName === 'VIDEO' && el.poster) {
        const a = abs(el.poster);
        if (a) push(a, 'image', 'dom');
      }
    }
  }

  function guessCat(src, tag) {
    const s = src.toLowerCase();
    if (/\.m3u8(\?|#|$)/.test(s)) return 'hls';
    if (/\.mpd(\?|#|$)/.test(s)) return 'dash';
    if (tag === 'VIDEO' || /\.(mp4|webm|mkv|mov|flv|avi|m4v)(\?|#|$)/.test(s)) return 'video';
    if (tag === 'AUDIO' || /\.(mp3|m4a|aac|wav|ogg|opus|flac)(\?|#|$)/.test(s)) return 'audio';
    return 'image';
  }

  // ---------- 2. 源码正则嗅探（捕捉 XHR 拉的流地址、播放器配置里的直链）----------
  const SOURCE_REGEX = /https?:\/\/[^\s"'<>()\\]+?\.(m3u8|mpd|mp4|m4v|webm|mkv|flv|mp3|m4a|aac|wav|ogg|opus|flac)(\?[^\s"'<>()\\]*)?/gi;

  function scanSource() {
    try {
      const html = document.documentElement.outerHTML;
      SOURCE_REGEX.lastIndex = 0;
      let m;
      while ((m = SOURCE_REGEX.exec(html)) !== null) {
        const url = m[0];
        const ext = m[1].toLowerCase();
        let cat = 'video';
        if (ext === 'm3u8') cat = 'hls';
        else if (ext === 'mpd') cat = 'dash';
        else if (['mp3', 'm4a', 'aac', 'wav', 'ogg', 'opus', 'flac'].includes(ext)) cat = 'audio';
        push(url, cat, 'source');
      }
    } catch (e) { /* ignore */ }
  }

  // ---------- 3. performance entries ----------
  function scanPerf() {
    try {
      const entries = performance.getEntriesByType('resource');
      for (const e of entries) {
        const u = e.name || '';
        const cat = categorizeByExt(u);
        if (cat) push(u, cat, 'network');
      }
    } catch (e) { /* ignore */ }
  }

  function categorizeByExt(u) {
    const s = u.toLowerCase().split(/[?#]/)[0];
    if (/\.m3u8$/.test(s)) return 'hls';
    if (/\.mpd$/.test(s)) return 'dash';
    if (/\.(mp4|m4v|webm|mkv|flv|avi|mov|wmv|3gp|ogv)$/.test(s)) return 'video';
    if (/\.(mp3|m4a|aac|wav|ogg|oga|opus|flac|wma|amr)$/.test(s)) return 'audio';
    if (/\.(jpe?g|png|gif|webp|bmp|svg|ico|avif|tiff?)$/.test(s)) return 'image';
    return null;
  }

  // 带 MIME 的完整分类（用于 hook 上报的请求）
  function categorizeFull(url, mime) {
    const lower = url.toLowerCase();
    if (/m3u8/.test(lower) && !/\.(js|css|html?|json|php)(\?|#|$)/i.test(lower)) return 'hls';
    if (/\.mpd(\?|#|$)/.test(lower) || /dash\+xml/.test(mime || '')) return 'dash';
    if (/mpegurl/.test(mime || '')) return 'hls';
    const byExt = categorizeByExt(url);
    if (byExt) return byExt;
    if (/\.ts(\?|#|$)/.test(lower)) return 'segment';
    if (mime) {
      if (/^video\//i.test(mime)) return 'video';
      if (/^audio\//i.test(mime)) return 'audio';
      if (/^image\//i.test(mime)) return 'image';
      // octet-stream 但 URL 疑似媒体（Hook 场景已由上面规则覆盖，这里兜底）
      if (/octet-stream/i.test(mime) && /\.(ts|m3u8)(\?|#|$)/i.test(lower)) return 'segment';
    }
    return null;
  }

  // ---------- 4. 接收 MAIN world hook 上报（fetch/XHR 劫持）----------
  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d) return;
    if (d.__mediaSniffer === true && d.url) {
      const cat = categorizeFull(d.url, d.mime);
      if (cat) {
        push(d.url, cat, 'hook');
        flush();
      }
    } else if (d.__mediaSnifferPlaylist === true && d.url) {
      // 把 m3u8 播放列表全文上报给后台（供完整合并下载）
      try {
        chrome.runtime.sendMessage({ type: 'playlist', url: d.url, body: d.body }, () => void chrome.runtime.lastError);
      } catch (e) {}
    }
  });

  // ---------- MutationObserver 监听动态插入 ----------
  const MO = window.MutationObserver
    ? new MutationObserver((muts) => {
        let sawVideo = false;
        for (const m of muts) {
          for (const node of m.addedNodes) {
            if (node.nodeType !== 1) continue;
            if (/^(IMG|VIDEO|AUDIO|SOURCE|TRACK|EMBED)$/.test(node.tagName)) {
              const src = node.currentSrc || node.src || node.getAttribute('src');
              if (src) {
                const a = abs(src);
                if (a) push(a, guessCat(src, node.tagName), 'dom');
              }
              if (node.poster) {
                const a = abs(node.poster);
                if (a) push(a, 'image', 'dom');
              }
            }
            if (node.tagName === 'VIDEO') sawVideo = true;
            // 容器节点：快速扫一遍子树
            if (node.querySelector) {
              const subs = node.querySelectorAll('img, video, audio, source, track, embed');
              for (const el of subs) {
                const src = el.currentSrc || el.src || el.getAttribute('src');
                if (src) {
                  const a = abs(src);
                  if (a) push(a, guessCat(src, el.tagName), 'dom');
                }
              }
            }
          }
        }
        flush();
        // 播放器动态创建 video 时，同步重扫页面源码（配置常在此时注入）
        if (sawVideo) scanSource();
      })
    : null;

  function start() {
    scanDom();
    scanSource();
    scanPerf();
    flush();
    if (MO) MO.observe(document.documentElement || document, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }

  // 前 60 秒每 5 秒重扫一次源码（播放器懒加载/延迟注入配置）
  let rescans = 0;
  const rescanTimer = setInterval(() => {
    try {
      scanSource();
      flush();
      if (++rescans >= 12) clearInterval(rescanTimer);
    } catch (e) { clearInterval(rescanTimer); }
  }, 5000);

  // 暴露给手动扫描脚本（content-scan.js）
  window.__mediaSnifferScan = function () {
    scanDom();
    scanSource();
    scanPerf();
    flush();
    return true;
  };
})();
