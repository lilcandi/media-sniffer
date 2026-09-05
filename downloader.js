// downloader.js — 独立扩展页上下文执行 m3u8 抓取/解密/合并/落盘
// 关键优势（相对旧 SW+offscreen 方案）：
//   1) 运行在扩展页(tab)上下文：URL.createObjectURL 可用、fetch 受 host_permissions 允许跨域、
//      页面常驻不被回收 → 大文件合并不会中途失败。
//   2) 任务来源：popup 把任务写入 chrome.storage.session，本页轮询取出执行；
//      本页已打开时，popup 直接向本页发消息追加任务。
//   3) 分片并发下载(默认6线程) + 内存按需合并，成功后 chrome.downloads 落盘。
(function () {
  'use strict';

  const CONCURRENCY = 6;
  const MAX_FAIL_RATIO = 0.05;
  let tasks = [];   // 已渲染任务
  let taskSeq = 0;

  const $ = (s) => document.querySelector(s);
  const queueEl = $('#queue');
  const emptyTipEl = $('#emptyTip');

  function safeName(name) {
    return String(name || 'video')
      .replace(/[<>:"|?*\x00-\x1f\\/]/g, '_')
      .trim()
      .replace(/\s+/g, '_')
      .slice(0, 120);
  }
  function fmtSize(n) {
    if (n == null) return '';
    if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
    if (n >= 1024) return (n / 1024).toFixed(0) + ' KB';
    return n + ' B';
  }
  function resolveSeg(base, seg) { try { return new URL(seg, base).href; } catch (e) { return seg; } }

  // ---------------- m3u8 解析（master→variant 递归）----------------
  async function swFetchText(url) {
    // 页内 fetch：受 host_permissions 保护，绕过页面 CORS。缓存 no-store 避免拿到过期 token。
    const res = await fetch(url, { cache: 'no-store', credentials: 'omit' });
    if (!res.ok) return null;
    return await res.text();
  }

  async function findWorkingM3u8(seedUrl) {
    // 1) 直接试传入 URL
    let text = await swFetchText(seedUrl).catch(() => null);
    if (text && /#EXTM3U/i.test(text)) return { url: seedUrl, text };
    // 2) 同目录候选名（处理 TS 分片被当作入口、或 token 使原 URL 失效等场景）
    let u;
    try { u = new URL(seedUrl); } catch (e) { return null; }
    const dir = u.pathname.slice(0, u.pathname.lastIndexOf('/') + 1);
    const file = u.pathname.split('/').pop();
    const stem = file.replace(/\.(ts|m3u8)(\?.*)?$/i, '');
    const query = u.search || '';
    const cands = [
      seedUrl,
      dir + stem + '.m3u8' + query,
      dir + 'index.m3u8' + query,
      dir + 'playlist.m3u8' + query,
      dir + 'master.m3u8' + query,
      dir + 'index.m3u8',
      dir + 'playlist.m3u8',
    ];
    for (const c of [...new Set(cands)]) {
      if (c === seedUrl) continue;
      let t = null;
      try { t = await swFetchText(c); } catch (e) {}
      if (t && /#EXTM3U/i.test(t)) return { url: c, text: t };
    }
    return null;
  }

  function ivFromSeq(seq) {
    const iv = new Uint8Array(16);
    new DataView(iv.buffer).setUint32(12, seq, false);
    return iv;
  }

  async function parseSegments(text, baseUrl, depth = 0) {
    // 返回 { segments:[{url,key,iv}], keysToFetch:Set }
    if (depth > 8 || !text) return [];
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    let segs = [];
    let curKey = null, curIv = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('#EXT-X-KEY')) {
        if (/METHOD=NONE/i.test(line)) { curKey = null; curIv = null; continue; }
        const um = line.match(/URI="([^"]*)"/i);
        const ivm = line.match(/IV=0x([0-9a-fA-F]{32})/i);
        if (um) curKey = resolveSeg(baseUrl, um[1]);
        if (ivm) {
          const iv = new Uint8Array(16);
          for (let k = 0; k < 16; k++) iv[k] = parseInt(ivm[1].slice(k * 2, k * 2 + 2), 16);
          curIv = iv;
        } else curIv = null;
      } else if (line.startsWith('#EXT-X-STREAM-INF')) {
        // master → 选第一条可解析的 variant 递归
        const v = lines[i + 1];
        if (v && /\.m3u8/i.test(v)) {
          const vu = resolveSeg(baseUrl, v);
          const t = await swFetchText(vu).catch(() => null);
          if (t && /#EXTM3U/i.test(t)) {
            const sub = await parseSegments(t, vu, depth + 1);
            if (sub.length) return sub; // 返回第一个能取的清晰度
          }
        }
      } else if (line.startsWith('#EXTINF')) {
        const uri = lines[i + 1];
        if (uri && !uri.startsWith('#')) {
          const u = resolveSeg(baseUrl, uri);
          const idx = segs.length;
          if (!segs.some((s) => s.url === u)) segs.push({ url: u, key: curKey, iv: curIv || ivFromSeq(idx), index: idx });
        }
      } else if (/^[^#]/.test(line) && !/\.m3u8(\?|#)?$/i.test(line)) {
        // 无 EXTINF 的裸分片列表
        const u = resolveSeg(baseUrl, line);
        const idx = segs.length;
        if (!segs.some((s) => s.url === u)) segs.push({ url: u, key: curKey, iv: curIv || ivFromSeq(idx), index: idx });
      }
    }
    return segs;
  }

  // 抓取单个分片（含 403/416 防盗链重试 1 次，网络异常重试 2 次）
  async function fetchSegBuffer(seg, referer) {
    const baseOpts = { cache: 'no-store', credentials: 'omit' };
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(seg.url, baseOpts);
        if (!res.ok) {
          // 403/416 可能源于防盗链 token：附加 referer + sec-fetch 头再试一次
          if ((res.status === 403 || res.status === 416) && attempt === 0) {
            const h = { 'sec-fetch-mode': 'no-cors', 'sec-fetch-site': 'same-site' };
            if (referer) h['Referer'] = referer;
            const res2 = await fetch(seg.url, { ...baseOpts, headers: h });
            if (res2.ok) return { buf: await res2.arrayBuffer(), http: 200 };
          }
          return { http: res.status, err: 'HTTP ' + res.status };
        }
        const buf = await res.arrayBuffer();
        return { buf, http: 200 };
      } catch (e) {
        if (attempt === 2) return { err: String((e && e.message) || e) };
      }
    }
    return { err: 'fetch failed' };
  }

  async function decryptSeg(buf, keyBytes, iv) {
    try {
      const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['decrypt']);
      return await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, buf);
    } catch (e) { return null; }
  }

  // 取解密密钥（带缓存）
  const keyCache = new Map();
  async function getKeyBytes(keyUrl) {
    if (keyCache.has(keyUrl)) return keyCache.get(keyUrl);
    const res = await fetch(keyUrl, { cache: 'no-store', credentials: 'omit' }).catch(() => null);
    if (!res || !res.ok) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    keyCache.set(keyUrl, buf);
    return buf;
  }

  // ---------------- 任务执行 ----------------
  function makeTaskDom(title, taskId) {
    emptyTipEl.classList.add('hidden');
    const card = document.createElement('div');
    card.className = 'card';
    card.id = 'task-' + taskId;
    card.innerHTML = `
      <div class="title">
        <span class="status-badge st-queued">排队</span>
        <span class="fn"></span>
      </div>
      <div class="bar"><i></i></div>
      <div class="meta"></div>
      <div class="row">
        <button class="stop danger">停止</button>
        <button class="retry">重试</button>
        <button class="openDir">打开下载目录</button>
      </div>`;
    card.querySelector('.fn').textContent = title;
    queueEl.appendChild(card);
    tasks.push({ id: taskId, card, stopped: false });
    return card;
  }

  function renderTask(task, obj) {
    const badge = task.card.querySelector('.status-badge');
    const bar = task.card.querySelector('.bar > i');
    const meta = task.card.querySelector('.meta');
    const row = task.card.querySelector('.row');
    const stopBtn = task.card.querySelector('.stop');
    const retryBtn = task.card.querySelector('.retry');
    badge.className = 'status-badge ' + (obj.cls || 'st-working');
    badge.textContent = obj.label;
    if (typeof obj.percent === 'number') bar.style.width = obj.percent + '%';
    meta.textContent = obj.text || '';

    // 终态清理既有提示块
    if (obj.done) {
      task.card.querySelector('.path') && task.card.querySelector('.path').remove();
      task.card.querySelector('.error') && task.card.querySelector('.error').remove();
    }

    // 按钮态：working→显示停止；done/error→隐藏停止、显示重试
    const finished = (obj.cls === 'st-done') || (obj.cls === 'st-error');
    if (finished) {
      stopBtn.classList.add('hidden');
      retryBtn.classList.remove('hidden');
      task.card.querySelector('.openDir').classList.remove('hidden');
      row.classList.remove('hidden');
    } else {
      stopBtn.classList.remove('hidden');
      stopBtn.disabled = false;
      stopBtn.textContent = '停止';
    }

    if (obj.path) {
      const p = document.createElement('div');
      p.className = 'path';
      p.textContent = '📁 ' + obj.path;
      task.card.appendChild(p);
    }
    if (obj.err) {
      const e = document.createElement('div');
      e.className = 'error';
      e.textContent = '❌ ' + obj.err;
      task.card.appendChild(e);
    }
    document.title = obj.label + ' — ' + (task.title || '');
  }

  async function runTask(task, spec) {
    task.title = spec.title;
    task.stopped = false;
    // 清理历史提示块
    task.card.querySelector('.path') && task.card.querySelector('.path').remove();
    task.card.querySelector('.error') && task.card.querySelector('.error').remove();
    renderTask(task, { cls: 'st-working', label: '解析中', text: '正在查找并解析 m3u8 播放列表…', percent: 2 });

    try {
      // 1) 找到可用的播放列表
      const found = await findWorkingM3u8(spec.url);
      if (!found) throw new Error('无法取得 m3u8 播放列表（入口 URL 及同目录候选均已尝试，可能地址已过期，请重新播放刷新地址）');

      // 2) 递归解析分片（master→variant 自动选第一条可用的）
      let segs = await parseSegments(found.text, found.url);
      if (!segs.length) {
        // 播放列表无 EXTINF（罕见），尝试把每一行当作分片
        throw new Error('播放列表中未找到可分片（m3u8: ' + found.url + '）');
      }
      const total = segs.length;

      // 3) 并发下载
      renderTask(task, { cls: 'st-working', label: '合并中', text: `共 ${total} 个分片，${CONCURRENCY} 线程并发下载…`, percent: 4 });
      const maxFail = Math.max(2, Math.ceil(total * MAX_FAIL_RATIO));
      let done = 0, failed = 0, http403 = 0;
      const buffers = new Array(total);
      let totalBytes = 0;
      // 防盗链重试时附带的 referer（用触发页 URL）
      const referer = spec.pageUrl || '';
      let stopFlag = false;

      let nextIdx = 0;
      async function worker() {
        while (!stopFlag && !task.stopped) {
          const idx = nextIdx++;
          if (idx >= total) break;
          const seg = segs[idx];
          try {
            // 加密分片：先确保拿到 key
            if (seg.key && !keyCache.has(seg.key)) {
              const kb = await getKeyBytes(seg.key);
              if (kb) keyCache.set(seg.key, kb);
            }
            const kb = seg.key ? keyCache.get(seg.key) : null;
            const r = await fetchSegBuffer(seg, referer);
            let data = null;
            if (r && r.buf) {
              data = kb ? await decryptSeg(r.buf, kb, seg.iv) : r.buf;
            }
            if (data && data.byteLength) {
              buffers[idx] = new Uint8Array(data);
              totalBytes += data.byteLength;
            } else {
              if (r && r.http === 403) http403++;
              failed++;
            }
          } catch (e) { failed++; }
          done++;
          if (failed > maxFail) { stopFlag = true; break; }
          const pct = 4 + Math.round((done / total) * 90);
          if (done % 3 === 0 || done === total) {
            renderTask(task, { cls: 'st-working', label: '合并中', text: `已下载 ${done}/${total} 分片（${fmtSize(totalBytes)}）`, percent: pct });
          }
        }
      }

      if (task.stopped) throw new Error('已手动停止');
      const workers = [];
      for (let i = 0; i < Math.min(CONCURRENCY, total); i++) workers.push(worker());
      await Promise.all(workers);

      if (stopFlag) {
        const hint = http403 > 0
          ? '（大量分片返回 403，播放地址 auth_key 很可能已过期：请回视频页重新播放一次刷新地址后再试）'
          : '';
        throw new Error(`分片下载/解密失败过多（${failed} 片，共 ${total} 片）${hint}`);
      }
      if (task.stopped) throw new Error('已手动停止');

      // 4) 合并成单个 ArrayBuffer
      renderTask(task, { cls: 'st-working', label: '合并中', text: `正在拼接 ${fmtSize(totalBytes)} 数据…`, percent: 96 });
      const merged = new Uint8Array(totalBytes);
      let off = 0;
      for (let i = 0; i < total; i++) {
        if (buffers[i]) { merged.set(buffers[i], off); off += buffers[i].length; buffers[i] = null; }
      }

      // 5) 生成 blob URL 并用 downloads 落盘
      renderTask(task, { cls: 'st-working', label: '保存中', text: '正在保存到浏览器下载目录…', percent: 98 });
      const mime = 'video/mp2t';
      const blob = new Blob([merged.buffer], { type: mime });
      const objUrl = URL.createObjectURL(blob);
      const filename = safeName(spec.title) + '.ts';

      const downloadId = await new Promise((resolve) => {
        chrome.downloads.download({ url: objUrl, filename, conflictAction: 'uniquify' }, (id) => resolve(id));
      });
      if (downloadId === undefined) {
        setTimeout(() => { try { URL.revokeObjectURL(objUrl); } catch (e) {} }, 3000);
        throw new Error('浏览器拒绝保存：' + ((chrome.runtime && chrome.runtime.lastError && chrome.runtime.lastError.message) || '未知'));
      }

      // 6) 解析真实路径（含 uniquify 后缀）
      let savedPath = filename;
      try {
        await new Promise((resolve) => {
          let i = 0;
          const tick = () => {
            chrome.downloads.search({ id: downloadId }, (ds) => {
              const d = ds && ds[0];
              if (d && d.state === 'complete' && d.filename) { savedPath = d.filename; return resolve(); }
              if (d && d.state === 'interrupted') { savedPath = d.filename || filename; return resolve(); }
              if (++i >= 60) { if (d && d.filename) savedPath = d.filename; return resolve(); }
              setTimeout(tick, 200);
            });
          };
          tick();
        });
      } catch (e) {}

      renderTask(task, {
        cls: 'st-done', label: '完成', done: true,
        text: `✅ ${filename}（${total} 分片合并，${fmtSize(totalBytes)}）`, percent: 100, path: savedPath,
      });
      task.done = true;
    } catch (e) {
      if (task.stopped) {
        renderTask(task, { cls: 'st-error', label: '已停止', done: true, text: '⏹ 已手动停止', percent: 0 });
      } else {
        renderTask(task, { cls: 'st-error', label: '失败', done: true, err: String((e && e.message) || e) });
      }
    }
  }

  // 绑定停止/重试/打开目录
  queueEl.addEventListener('click', (e) => {
    const stop = e.target.closest('.stop');
    const retry = e.target.closest('.retry');
    const openDir = e.target.closest('.openDir');
    const card = e.target.closest('.card');
    if (!card) return;
    const task = tasks.find((t) => 'task-' + t.id === card.id);
    if (!task) return;
    if (stop) {
      task.stopped = true;
      stop.disabled = true;
      stop.textContent = '停止中…';
    }
    if (retry && task.spec) {
      task.stopped = false;
      task.done = false;
      runTask(task, task.spec);
    }
    if (openDir) {
      chrome.downloads.showDefaultFolder();
    }
  });

  // 新增任务（来自 popup 消息或 storage.session）
  async function enqueue(spec) {
    const task = { id: ++taskSeq, spec, stopped: false, done: false };
    const card = makeTaskDom(spec.title || spec.url, task.id);
    task.card = card;
    // 若正在执行另一个大任务，排队显示（简化：直接并行执行多个也没问题，各自独立 worker）
    runTask(task, spec).catch(() => {});
  }

  // 主流程：读 storage.session 未处理任务 + 监听消息
  const processedKeys = new Set();
  async function drain() {
    try {
      const res = await chrome.storage.session.get(null);
      for (const k of Object.keys(res)) {
        if (k.startsWith('msTask_') && !processedKeys.has(k)) {
          processedKeys.add(k);
          const spec = res[k];
          await enqueue(spec);
          await chrome.storage.session.remove(k);
        }
      }
    } catch (e) {}
  }
  // 页内消息：popup 可能已开着本页，直接追加
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'addTask') {
      enqueue(msg.spec || { url: msg.url, title: msg.title }).catch(() => {});
      sendResponse({ ok: true });
      return true;
    }
  });

  // 初次加载轮询 storage（popup 可能在本页创建完成前就已写入）
  drain();
  setInterval(drain, 1200);
  // 支持 ?url= 参数直接下载（调试/手动场景）
  try {
    const q = new URLSearchParams(location.search);
    const url = q.get('url');
    if (url && /^https?:/i.test(url)) enqueue({ url, title: q.get('title') || 'video' });
  } catch (e) {}
})();
