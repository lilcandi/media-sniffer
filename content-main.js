// Media Sniffer - MAIN World Hook
// 注入到页面主世界，劫持 fetch / XMLHttpRequest，从源头捕获媒体请求
// （m3u8 等常通过 XHR 拉取且 URL 无媒体特征，webRequest 的扩展名/响应头识别会漏掉）

(function () {
  'use strict';
  if (window.__mediaSnifferHooked) return;
  window.__mediaSnifferHooked = true;

  const RE_EXT = /\.(m3u8|mpd|mp4|m4v|webm|mkv|flv|avi|mov|ts|mp3|m4a|aac|wav|ogg|oga|opus|flac)(\?|#|$)/i;

  const RE_TOOL = /\.(js|css|html?|json|php)(\?|#|$)/i;

  function interesting(url, mime) {
    if (!url || !/^https?:/i.test(url)) return false;
    if (RE_EXT.test(url)) return true;
    if (/m3u8|mpegurl/i.test(url) && !RE_TOOL.test(url)) return true; // 无后缀的签名播放列表地址
    if (/\.mpd(\?|#|$)|dash\+xml/i.test(url + (mime || ''))) return true;
    if (mime) {
      if (/^(video|audio)\//i.test(mime)) return true;
      if (/mpegurl|dash\+xml/i.test(mime)) return true;
    }
    return false;
  }

  function report(url, mime) {
    try {
      window.postMessage({ __mediaSniffer: true, url: String(url), mime: mime || '' }, '*');
    } catch (e) { /* ignore */ }
  }

  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      let reqUrl = '';
      try {
        reqUrl = input instanceof Request ? input.url : String(input);
      } catch (e) { /* ignore */ }
      const p = origFetch.apply(this, arguments);
      p.then((res) => {
        try {
          const mime = (res.headers && res.headers.get('content-type')) || '';
          const finalUrl = res.url || reqUrl;
          if (interesting(reqUrl, mime) || interesting(finalUrl, mime)) {
            report(finalUrl, mime);
            // 若是 m3u8 播放列表，把响应体存起来（用于完整合并下载）
            if (/m3u8|mpegurl|octet-stream/i.test(mime + finalUrl) && /m3u8/i.test(finalUrl)) {
              res.clone().text().then((t) => reportPlaylist(finalUrl, t)).catch(() => {});
            }
          } else if (/json|text|javascript|html/i.test(mime)) {
            // 播放器配置接口：m3u8 藏在 JSON/文本响应体里（播放失败时也抓得到）
            res.clone().text().then((t) => scanBody(t, finalUrl)).catch(() => {});
          }
        } catch (e) { /* ignore */ }
      }).catch(() => {});
      return p;
    };
  }

  // 上报 m3u8 播放列表全文（供完整合并下载）
  function reportPlaylist(url, body) {
    try {
      window.postMessage({ __mediaSnifferPlaylist: true, url: String(url), body: String(body).slice(0, 1024 * 1024) }, '*');
    } catch (e) {}
  }

  // 从响应体文本中提取媒体直链
  const RE_BODY_URL = /https?(?::|%3A)[^\s"'<>()\\]*?\.(?:%2F|\/)?(?:m3u8|mpd|mp4|m4v|mkv|webm|flv|mp3|m4a|aac)(?:\?[^\s"'<>()\\]*)?/gi;

  function scanBody(text, baseUrl) {
    if (!text || text.length > 3 * 1024 * 1024) return;
    let found = 0;
    try {
      const unescaped = text.replace(/\\\//g, '/'); // JSON 转义的 \/
      RE_BODY_URL.lastIndex = 0;
      let m;
      while ((m = RE_BODY_URL.exec(unescaped)) !== null && found < 30) {
        report(m[0], 'in-body');
        found++;
      }
    } catch (e) { /* ignore */ }
  }

  // ---- XHR hook ----
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    try { this.__msUrl = String(url); } catch (e) { this.__msUrl = ''; }
    return origOpen.apply(this, arguments);
  };
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function () {
    const xhr = this;
    if (xhr.__msUrl) {
      xhr.addEventListener('load', () => {
        try {
          const mime = xhr.getResponseHeader('content-type') || '';
          if (interesting(xhr.__msUrl, mime)) report(xhr.__msUrl, mime);
          // responseURL 可能与 open 的 url 不同（重定向）
          if (xhr.responseURL && xhr.responseURL !== xhr.__msUrl && interesting(xhr.responseURL, mime)) {
            report(xhr.responseURL, mime);
          }
          if (/m3u8|mpegurl/i.test(mime) && /m3u8/i.test(xhr.responseURL || xhr.__msUrl)) {
            if (xhr.responseType === '' && xhr.responseText) reportPlaylist(xhr.responseURL || xhr.__msUrl, xhr.responseText);
            else if (xhr.response && xhr.response.text) xhr.response.text().then((t) => reportPlaylist(xhr.responseURL || xhr.__msUrl, t)).catch(() => {});
          }
          // JSON/文本响应体里也可能藏媒体直链
          if (/json|text|javascript|html/i.test(mime) && xhr.responseType === '' && xhr.responseText) {
            scanBody(xhr.responseText, xhr.responseURL || xhr.__msUrl);
          }
        } catch (e) { /* ignore */ }
      });
    }
    return origSend.apply(this, arguments);
  };
})();
