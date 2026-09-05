// Media Sniffer - Popup 逻辑
(function () {
  'use strict';

  let allItems = [];
  let activeCat = 'all';
  let currentTabId = null;
  let currentTabTitle = '';
  let currentPageUrl = '';
  let filterSmall = false;
  let downloading = false; // 防重复下载
  let statusOverride = ''; // 非空时优先展示（避免被 render 的统计文案覆盖）
  let statusTimer = null;

  const $ = (sel) => document.querySelector(sel);
  const listEl = $('#list');
  const emptyEl = $('#empty');
  const statusEl = $('#status');

  const CAT_GROUP = { hls: 'stream', dash: 'stream', segment: 'stream' };
  const CAT_LABEL = { video: '视频', audio: '音频', hls: 'HLS', dash: 'DASH', segment: 'TS分片', image: '图片' };
  const CAT_ORDER = { hls: 0, dash: 0, video: 1, audio: 2, segment: 3, image: 4 };

  function groupOf(item) {
    return CAT_GROUP[item.cat] || item.cat;
  }

  function fmtSize(n) {
    if (n == null) return '';
    if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
    if (n >= 1024) return (n / 1024).toFixed(0) + ' KB';
    return n + ' B';
  }

  function send(msg) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(msg, (res) => resolve(res || {}));
    });
  }

  async function load() {
    // 支持调试/测试：popup.html?tab=<id> 显式指定目标标签页（无参数则取当前活动页）
    let targetId = null;
    try {
      const q = new URLSearchParams(location.search).get('tab');
      if (q) targetId = Number(q);
    } catch (e) {}
    if (targetId != null) {
      currentTabId = targetId;
      chrome.tabs.get(targetId, (t) => {
        currentTabTitle = (t && t.title) || '';
        currentPageUrl = (t && t.url) || '';
        refresh();
      });
    } else {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      currentTabId = tab ? tab.id : null;
      currentTabTitle = tab && tab.title ? tab.title : '';
      currentPageUrl = tab && tab.url ? tab.url : '';
      if (currentTabId != null) refresh();
    }
    async function refresh() {
      if (currentTabId == null) return;
      const res = await send({ type: 'get', tabId: currentTabId });
      allItems = res.items || [];
      currentPageUrl = res.pageUrl || currentPageUrl;
      render();
    }
  }

  function filtered() {
    let kw = $('#search').value.trim().toLowerCase();
    return allItems.filter((it) => {
      if (activeCat !== 'all' && groupOf(it) !== activeCat) return false;
      if (filterSmall && it.cat === 'image' && it.size != null && it.size < 10 * 1024) return false;
      if (kw && !it.url.toLowerCase().includes(kw) && !(it.filename || '').toLowerCase().includes(kw)) return false;
      return true;
    });
  }

  function render() {
    // 更新计数
    const counts = { all: allItems.length, video: 0, audio: 0, stream: 0, image: 0 };
    for (const it of allItems) counts[groupOf(it)]++;
    for (const key of Object.keys(counts)) {
      const el = $('#cnt-' + key);
      if (el) el.textContent = counts[key];
    }

    const items = filtered();
    emptyEl.classList.toggle('hidden', items.length > 0);
    listEl.classList.toggle('hidden', items.length === 0);

    // 按类别 + 时间排序（新发现的在前，图片排后）
    items.sort((a, b) => (CAT_ORDER[a.cat] ?? 9) - (CAT_ORDER[b.cat] ?? 9) || (b.time - a.time));

    listEl.textContent = '';
    const frag = document.createDocumentFragment();

    for (const it of items) {
      const card = document.createElement('div');
      card.className = 'item';

      const head = document.createElement('div');
      head.className = 'item-head';

      const badge = document.createElement('span');
      badge.className = 'badge ' + it.cat;
      badge.textContent = CAT_LABEL[it.cat] || it.cat;

      const name = document.createElement('span');
      name.className = 'filename';
      name.title = it.filename || it.url;
      name.textContent = it.filename || it.url;

      const meta = document.createElement('span');
      meta.className = 'meta';
      const sizeTxt = fmtSize(it.size);
      meta.textContent = (sizeTxt ? sizeTxt : '') + (it.from === 'source' ? ' · 页面解析' : it.from === 'dom' ? ' · DOM' : '');

      head.append(badge, name, meta);

      const urlEl = document.createElement('div');
      urlEl.className = 'url';
      urlEl.title = '点击复制链接\n' + it.url;
      urlEl.textContent = it.url;
      urlEl.addEventListener('click', () => copy(it.url));

      const actions = document.createElement('div');
      actions.className = 'actions';

      const copyBtn = document.createElement('button');
      copyBtn.className = 'btn small';
      copyBtn.textContent = '📋 复制链接';
      copyBtn.addEventListener('click', () => copy(it.url));

      const dlBtn = document.createElement('button');
      dlBtn.className = 'btn small';
      dlBtn.textContent = '⬇ 下载';
      dlBtn.addEventListener('click', () => download(it));
      if (/^blob:/i.test(it.url)) {
        dlBtn.disabled = true;
        dlBtn.title = 'blob 链接无法直接下载，请在播放页另存';
      }

      // 流媒体条目提供「一键下载并合并完整视频」
      const isStream = ['hls', 'dash', 'segment'].includes(it.cat) && !/^blob:/i.test(it.url);
      if (isStream) {
        const fullBtn = document.createElement('button');
        fullBtn.className = 'btn small primary';
        fullBtn.textContent = it.cat === 'hls' ? '🎬 下载完整视频' : '🎬 完整视频';
        // TS 分片触发下载的成功率较低：m3u8 可能在不同子域；优先等嗅探到 m3u8 入口
        fullBtn.title = it.cat === 'segment'
          ? '尝试合并同名的 m3u8 分片（成功率较低，建议等嗅探到 m3u8 入口后再点）。TS 与 m3u8 可能跨子域。'
          : '抓取完整分片并合并为 TS（用页面标题命名）';
        fullBtn.disabled = downloading; // 下载期间禁用，防止重复
        fullBtn.addEventListener('click', () => downloadFull(it));
        actions.append(copyBtn, fullBtn, dlBtn);
      } else {
        actions.append(copyBtn, dlBtn);
      }

      card.append(head, urlEl, actions);
      frag.appendChild(card);
    }
    listEl.appendChild(frag);

    // 状态栏：有 override（下载中/错误/成功等临时提示）则优先显示，避免被列表统计文案覆盖
    if (statusOverride) {
      statusEl.textContent = statusOverride;
    } else {
      statusEl.textContent = items.length
        ? `共 ${allItems.length} 条资源，当前显示 ${items.length} 条`
        : '';
    }
  }

  function setStatus(txt, sticky = false) {
    statusOverride = txt;
    statusEl.textContent = txt;
    // 非 sticky（默认）：3 秒后清 override 回到列表文案；sticky（成功/失败终态）：保留 8 秒
    clearTimeout(statusTimer);
    const hold = sticky ? 8000 : 3000;
    statusTimer = setTimeout(() => {
      statusOverride = '';
      if (downloading) statusEl.textContent = statusEl.textContent;
      render();
    }, hold);
    // 渲染列表（按钮禁用态可能变化），但不清 override —— render 内部尊重 statusOverride
    render();
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      setStatus('✅ 已复制到剪贴板');
    } catch (e) {
      // fallback
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      setStatus('✅ 已复制到剪贴板');
    }
  }

  // 把 TS 分片文件名末尾直接换成 .m3u8（不删除任何数字），保留 query
  // 真实示例：.../video5/<id>/<id>119113.ts  →  .../video5/<id>/<id>119113.m3u8
  function deriveM3u8FromSegment(segUrl) {
    const qIdx = segUrl.indexOf('?');
    const query = qIdx >= 0 ? segUrl.slice(qIdx) : '';
    const path = qIdx >= 0 ? segUrl.slice(0, qIdx) : segUrl;
    // 去掉可能的分片前缀 /xxx 段可能多个，逐级尝试
    const base = path.replace(/\.ts(\?.*)?$/i, '');
    return base + '.m3u8' + query;
  }

  // 一键下载并合并完整视频：把任务交给独立下载页执行（cat-catch 同款架构）。
  // 下载页是扩展 tab，可长驻、可用 createObjectURL、fetch 无跨域限制，避免 SW+offscreen 被回收导致大视频下载中断。
  async function downloadFull(it) {
    if (downloading) return setStatus('⏳ 正在安排下载，请稍候…');
    if (currentTabId == null) return setStatus('❌ 无法确定当前标签页');
    if (/^blob:/i.test(it.url)) return setStatus('❌ blob 链接无法合并，请直接下载原文件');
    const m3u8 = it.cat === 'hls' ? it.url : deriveM3u8FromSegment(it.url);
    const title = currentTabTitle || 'video';
    const spec = { url: m3u8, title, pageUrl: (currentPageUrl || ''), tabId: currentTabId };

    downloading = true;
    setDownloadingState(true);
    const done = () => { downloading = false; setDownloadingState(false); };

    // 1) 若已有下载页开着，直接向它推送任务
    try {
      const tabs = await chrome.tabs.query({});
      const downTab = tabs.find((t) => t.url && t.url.includes('/downloader.html'));
      if (downTab && downTab.id != null) {
        await new Promise((resolve) => chrome.tabs.sendMessage(downTab.id, { type: 'addTask', spec }, () => resolve()));
        setStatus('✅ 任务已交给「媒体下载合并」页，请切到该页查看进度', true);
        done(); setTimeout(render, 800);
        return;
      }
    } catch (e) { /* 无接收方则走下方新开下载页 */ }

    // 2) 无打开页：写 storage.session 让下载页 onload 拉取，再新开下载页
    const key = 'msTask_' + Date.now();
    try {
      await new Promise((resolve) => chrome.storage.session.set({ [key]: spec }, () => resolve()));
    } catch (e) {}
    chrome.tabs.create({ url: chrome.runtime.getURL('downloader.html'), active: false }, (t) => {
      setStatus('🆕 已打开「媒体下载合并」页并开始下载，可关闭本弹窗', true);
      done(); setTimeout(render, 800);
    });
  }

  // 下载期间禁用所有「下载完整视频」按钮
  function setDownloadingState(dis) {
    document.querySelectorAll('.btn.primary').forEach((b) => { b.disabled = dis; });
  }

  function download(it) {
    const filename = makeSafeName(it);
    chrome.downloads.download(
      { url: it.url, filename, conflictAction: 'uniquify' },
      (downloadId) => {
        if (downloadId === undefined) {
          setStatus('❌ 下载失败：' + (chrome.runtime.lastError ? chrome.runtime.lastError.message : '浏览器拒绝了该请求'));
        } else {
          setStatus('⬇️ 已开始下载');
        }
      }
    );
  }

  function makeSafeName(it) {
    let name = (it.filename || '').split(/[\\/]/).pop() || 'media';
    // m3u8 等无扩展名的流补一个
    if (!/\.[a-z0-9]{2,5}$/i.test(name)) {
      const extByCat = { hls: 'm3u8', dash: 'mpd', video: 'mp4', audio: 'mp3', image: 'jpg' };
      name += '.' + (extByCat[it.cat] || 'bin');
    }
    return name.replace(/[<>:"|?*\x00-\x1f]/g, '_');
  }

  // ---------- 事件绑定 ----------

  $('#tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (!btn) return;
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    btn.classList.add('active');
    activeCat = btn.dataset.cat;
    render();
  });

  $('#search').addEventListener('input', render);

  $('#filterSmall').addEventListener('change', (e) => {
    filterSmall = e.target.checked;
    chrome.storage.local.set({ filterSmall });
    render();
  });

  $('#rescan').addEventListener('click', async () => {
    if (currentTabId == null) return;
    // 不清空旧记录（避免清掉已嗅探到的流），只增量扫描
    const res = await send({ type: 'scan', tabId: currentTabId });
    setStatus(res.ok ? '🔄 已重新扫描（增量）' : '❌ 扫描失败（可能是浏览器内置页）');
    setTimeout(load, 600);
  });

  $('#clear').addEventListener('click', async () => {
    if (currentTabId == null) return;
    await send({ type: 'clear', tabId: currentTabId });
    allItems = [];
    render();
    setStatus('🧹 已清空');
  });

  $('#copyAll').addEventListener('click', () => {
    const items = filtered();
    if (!items.length) return setStatus('没有可复制的资源');
    copy(items.map((i) => i.url).join('\n'));
  });

  $('#downloadAll').addEventListener('click', () => {
    const items = filtered().filter((i) => !/^blob:/i.test(i.url));
    if (!items.length) return setStatus('没有可下载的资源');
    if (items.length > 20 && !confirm(`即将下载 ${items.length} 个文件，是否继续？`)) return;
    for (const it of items) download(it);
  });

  // ---------- 初始化 ----------

  chrome.storage.local.get('filterSmall').then((r) => {
    filterSmall = !!r.filterSmall;
    $('#filterSmall').checked = filterSmall;
    render();
  });

  load();
})();
