# Media Sniffer 媒体嗅探器 — 浏览器扩展

嗅探网页中的视频、音频、图片及 m3u8(HLS) / mpd(DASH) 流媒体资源，支持一键复制、下载并**自动合并为完整视频**。

## 发布信息（GitHub）

- **仓库**：https://github.com/lilcandi/media-sniffer （public）
- **本地提交**：`677f7ec` `main` → 远程 `main` 一致
- **打包产物**：`media-sniffer-v1.5.0.zip`（项目根，被 .gitignore 排除不入库；含运行文件 + 安装说明，开发者模式解压加载）
- **推送技术备注**：本机走 Watt Toolkit(SOCKS 7897) 访问 GitHub。git 默认 schannel 栈经代理 TLS 会崩，须用 `openssl` 后端 + 桥接透传代理；详见 `_pkg_tmp/bridge_proxy.py` 与 `gitpush.sh`（复用工具，留在临时目录）。

## v1.5.0 架构重构（m3u8 下载迁至独立扩展页 — 参考 cat-catch 根治 Chrome 下载中断）

**用户现象**：换到 Chrome 后「无论如何都下载不了完整视频」（v1.4.x 在 Edge 实测可用，但依赖 SW 的下载合并链路脆弱）。

**根因（针对 MV3 Service Worker 的三处致命脆弱点）**：
1. SW 无法 `URL.createObjectURL` → 只能绕道 offscreen 文档生成 blob，链路长、易断
2. `chrome.runtime.sendMessage` 传大二进制会截断 → 必须经 IndexedDB 中转，大文件(743MB)内存峰值约 1.5GB，浏览器易 OOM 杀掉 SW
3. SW 随时可能被浏览器回收，`sendResponse` 字段丢失（MV3 channel close）→ 需 storage.session + long-poll 层层兜底，仍不可靠

**新方案（借鉴 cat-catch 的下载模型）**：
> 把「抓取 m3u8 → 并发下载分片 → AES 解密 → 合并 → 落盘」整体从 SW 迁到**独立扩展页 `downloader.html`**（一个真实 tab）。页面上下文：`URL.createObjectURL` 天然可用、`fetch` 受 host_permissions 保护无 CORS、页面常驻不被回收。SW 只保留嗅探 + 存储。

**改动清单**：
1. **新增 `downloader.html` + `downloader.js`**：常驻下载管理页。
   - 分片**6 线程并发下载**（自实现 worker 池，借鉴 cat-catch），进度实时刷新
   - master→variant 自动递归选第一条可用的清晰度；`#EXT-X-KEY` AES-128 用 WebCrypto 解密
   - 防盗链健壮性：403/416 时自动附加 `Referer` + `sec-fetch` 头重试；网络异常重试
   - 成功 → `URL.createObjectURL(blob)` → `chrome.downloads.download`（blob: URL），轮询解析真实落盘路径
   - UI：任务卡片显示状态徽章/进度条/分片计数/完成路径/失败原因，含 停止/重试/打开下载目录 按钮
   - 失败提示含 403 大量发生时「播放地址 auth_key 过期，请重播刷新」指引
2. **`popup.js` 的「🎬 下载完整视频」改为**：向已开下载页发消息追加任务；否则写 `storage.session[msTask_*]` 并 `chrome.tabs.create` 打开下载页。弹窗立即反馈「已交给下载页」，可关闭，不再 `await` SW 长任务。`get` 时带回 `pageUrl` 供防盗链。
3. **`background.js` 大幅精简**：删除 offscreen/IndexedDB/downloadM3u8Full 全套下载合并逻辑与 message handlers，SW 只做 webRequest 嗅探、按标签页存储、页面扫描、`pageUrl`(referer) 记录。已移除 `offscreen` 权限。
4. **删除 `offscreen.html` / `offscreen.js`**（不再需要）。

**验证**（`test/e2e-v15.mjs`，真实 Chrome 页面上下文跑通 downloader.js 引擎）：
- 本地起 HTTP 供带 AES-128 加密的 master→variant m3u8（8 分片）
- downloader.js 抓全部分片 + WebCrypto 解密 + 合并 = **字节精确 9024B**，`chrome.downloads.download(blobUrl)` 被正确调用、TS 头 `0x47` 同步字节正确 → **PASS**
- （本机 Chrome 137+ 不支持 `--load-extension`，故采用「真实页面 + chrome API 桩」验证引擎数据链路；装到浏览器后 Chrome/Edge 均为标准 MV3 行为）

**使用方法（Chrome）**：`chrome://extensions` → 开发者模式 → 加载已解压 → 选本目录。刷新插件后到任意视频页播放 → 点嗅探弹窗「🎬 下载完整视频」→ 自动新开「媒体下载合并」页并开始下载 → 完成后显示文件路径。

**注意**：`test/dl-out/` 下残留少量 Edge 启动失败的 `.edge-profile-*` 浏览器 profile 目录（约 267MB，系统文件安全守卫阻止批量清理），不影响扩展本体，可手动删除。



## v1.4.3 更新（完成时显示真实保存路径 + 分片鉴权过期提示）

**用户现象**：点击「🎬 下载完整视频」显示「下载合并中 N/M 分片…」，但找不到下载文件。

**排查结论**：真实站点端到端验证（`test/final-verify.mjs`）确认**下载链路完全正常**——453 分片、743MB 视频合并后由 `chrome.downloads` 完整落盘到 `J:\dl\《页面标题》.ts`（state=complete，字节数精确一致）。同一视频在 `J:\dl` 已累计 3 个完整副本（均 743MB/767MB）。**用户"找不到文件"的最常见原因：文件落到的是浏览器配置的下载目录（本机为 `J:\dl`），而非系统默认「下载」文件夹。**

**本版修复（提升可感知性 + 容错）**：
1. `downloadM3u8Full` 合并完成后短轮询 `chrome.downloads.search` 解析**真实落盘全路径** `savedPath`（含 uniquify 产生的 `(1)` 后缀），随结果返回
2. popup `showResult` 成功提示改为两行：`✅ 已保存完整视频「xxx」（N 分片合并）\n📁 <完整落盘路径>`——用户一眼看到文件去哪了
3. 分片下载统计 HTTP 状态：当大量分片返回 403（鉴权 auth_key 过期）时，失败信息附上操作指引「请回到视频页重新播放一次，让扩展抓到新地址后再下载」
4. `swFetch` 返回结构化错误（`{http:状态}` / `{err}`），便于区分网络失败与鉴权失败

**验证**：本地加密 master（跨域 variant）下载返回 `{"ok":true,"name":"主播放列表测试.ts","savedPath":"J:\\dl\\主播放列表测试 (1).ts","segs":3,...}`——落盘路径正确解析。

> ⚠️ 若仍「没文件」，请：① 检查是否在合并完成前关闭了 popup（后台仍会完成下载）；② 到 `edge://settings/downloads` 确认下载目录；③ 重新播放一次视频再点下载（刷新 auth_key）。

## v1.4.2 更新（修复「点击完整视频没反应」）

**用户现象**：文件已下载到硬盘，但点击 popup 里的「完整视频」按钮看不到任何 UI 反馈。

**根因**：点击按钮后的状态提示被列表重渲染覆盖——
- 旧 `setStatus()` 里 `setTimeout(render, 1200)`：每次状态栏提示后 1.2 秒就触发一次 `render()`，而 `render()` 无条件把状态栏写成「共 N 条资源…」，把「⏳ 已提交…」提示冲掉
- `downloadFull()` 的 `await send(...)` 会一直挂起直到 SW 完成整个合并（大视频数分钟），期间进度轮询是 `setInterval` 但提示同样会被 render 覆盖 → 用户看到「没反应」

**本版修复**：
1. 引入 `statusOverride` 状态：`render()` 尊重它，有临时提示（提交中/进度/结果）就不覆盖；无提示时才显示列表统计
2. `setStatus(txt, sticky)`：默认 3 秒后回列表；成功/失败用 `sticky=true` 停留 8 秒
3. `downloadFull()` 重构：
   - 点击后立即显示「⏳ 已提交，正在解析播放列表并下载合并…」
   - 下载期间开 800ms 进度轮询 `getMergeProgress`，持续刷新「⏳ 下载合并中 N/M 分片…」（同时重置 override 清理定时器，全程可见）
   - `await send` 返回后：优先展示返回的成功 `name` / 失败 `error`；字段被 MV3 channel close 丢弃时从 `chrome.storage.session[dlLast_<tabId>]` 兜底拉真实终态（等最多 6 秒）；实在拿不到则如实提示「已提交到浏览器后台合并，请留意下载栏」
   - 防并发：下载前探测 `getMergeProgress.active`，SW 仍在合并上一次任务时提示「稍候」而非并发下载
4. `load()` 支持 `popup.html?tab=<id>` 便于精确定位标签页（不影响默认取当前活动页）
5. TS 分片按钮提示 TS 与 m3u8 可能跨子域

**验证**（`test/click-real.mjs` 真实点击 popup 按钮）：
- 渲染出 HLS 条目 + 「🎬 下载完整视频」按钮 → 真实点击
- 状态栏从「⏳ 已提交」→（若快）「✅ 已保存完整视频「<页面标题>.ts」（3 分片合并）」停留 8 秒
- downloads 落盘 `J:\dl\真实点击测试页面.ts`，2820 字节 complete（用页面标题命名）
- `test/progress-probe.mjs` 慢下载（80 分片）采样到 `getMergeProgress = 65/80`，说明大视频进度实时可读

## v1.4.1 更新（修复「下载完整视频」未知错误 + TS→m3u8 倒推）

- **修复核心 bug（🔧 真实失败根因）**：v1.4.0 中从 TS 分片按钮触发时
  - popup.js 旧 `deriveM3u8FromSegment` 用 `replace(/\d+$/, '')` 删除末尾数字（错误的：分片名末位属于段号，不能删）
  - background.js 主入口仅校验播放列表文本存在，不再尝试同目录其它候选
  - 真实表现：下载按钮点完弹「未知错误」（popup 端 `res.error` 字段被 Chrome MV3 channel close 机制吃掉）
- **本版修复**：
  1. popup.js `deriveM3u8FromSegment` 改为「`.ts` → `.m3u8`」**保持全部数字**，仅保留 query
  2. background.js 新增 `findWorkingM3u8(seedUrl)`：原始 m3u8 URL 不可解析时，回退尝试 `name.m3u8 / index.m3u8 / playlist.m3u8 / master.m3u8` 同目录候选
  3. SW `downloadM3u8` 流程把**最终结果**写入 `chrome.storage.session[dlLast_<tabId>]`，popup 端 `pollLastDownload` 兜底轮询
     - 解决 Chrome MV3 中「`sendResponse` 异步丢字段」导致 popup 端看不到真实错误信息的问题
  4. popup 错误显示容错：空 error 字段 / 空对象 → 显示「请点「重扫」后再试」
  5. TS 分片按钮 tooltip 增加提示「TS 与 m3u8 可能跨子域，建议等嗅探到 m3u8 入口再点」
- **验证**（端到端 `test/e2e-seg.mjs`）：
  - A. 正确 m3u8 URL → 3 分片 AES-128 解密合并落盘 `J:\dl\<页面标题>.ts`，2820 字节，TS 同步字节 100%
  - C. 错误 m3u8 URL → long-poll 拿到 `error: "无法取得 m3u8 播放列表（已尝试：...）"`
  - 真实站点 (`gkinowikiwik.*/archives/214027/`)：嗅探到稳定 m3u8 入口（`hls.piotrt.cn/...m3u8?auth_key=...`），一键下载即可工作

## v1.4.0 更新（一键下载完整视频 + AES-128 解密合并）

- **「🎬 下载完整视频」按钮**：流媒体条目（m3u8/TS 分片）自动抓取完整分片列表、逐段下载、合并为一个 `.ts` 文件，用**浏览器标签标题**命名保存
- **AES-128 加密流支持**：解析 `#EXT-X-KEY`，自动抓取 `crypt.key`、按 IV/序号解密每个分片（WebCrypto AES-CBC），输出可播放的合并视频（已用真实站点数据验证：解密后 TS 同步字节 9532/9532 全中）
- **多码率 master 自动取首个 variant**；支持相对路径、裸分片
- **MV3 大文件导出链路**：SW 抓取+解密+合并 → 写入 IndexedDB → 离屏文档(offscreen) 组装 Blob 生成 `blob:` URL → SW 用 `chrome.downloads` 保存。原因：MV3 SW 无 `URL.createObjectURL`，且 `chrome.runtime` 消息无法可靠传大二进制
- 合并进度实时显示在 popup 底部
- 说明：产物为 `.ts`（MPEG-TS 容器），VLC/Edge/PotPlayer/ffplay 均可直接播放；如需 mp4 容器可用 ffmpeg 一键转

## 历史迭代

- **v1.2.1** 修复 popup 分组 bug：TS 分片（segment）此前未纳入「流媒体」分类 Tab，导致显示为空
- **v1.2.0** 播放失败场景兜底：劫持 fetch/XHR 连 JSON 响应体一起扫（含 `\/` 转义还原）、前 60 秒定时重扫源码、重扫改增量不清空
- **v1.1.0** MSE 播放器站点嗅探：MAIN World 劫持 fetch/XHR、URL 含 m3u8 关键词识别、TS 分片识别

## 安装方式

1. 打开 `chrome://extensions`（Edge 为 `edge://extensions`）
2. 右上角开启「开发者模式」
3. 「加载已解压的扩展程序」→ 选择 `K:\vibecoding\media-sniffer`

## 使用方式

- 打开含媒体网页 → 播放视频 → 点扩展图标，m3u8 出现在「流媒体」分类
- 点该条目「🎬 下载完整视频」→ 自动合并下载为《页面标题》.ts（带进度）
- 也可「复制链接」配合 N_m3u8DL-RE 等工具下载

## 文件结构

```
media-sniffer/
├── manifest.json      # MV3 配置（含 offscreen 权限）
├── background.js      # SW：webRequest 嗅探 + HLS 抓取/解密/合并 + 下载调度
├── offscreen.js/html  # 离屏文档：IndexedDB 取数据→Blob→blob: URL
├── content.js         # DOM/源码/performance 扫描 + MutationObserver + 消息转发
├── content-main.js    # MAIN World：fetch/XHR 劫持 + 响应体扫描
├── content-scan.js    # 手动重扫脚本
├── popup.html/css/js  # 弹窗（分类/搜索/复制/下载完整视频）
├── icons/             # 16/32/48/128 PNG
├── test/              # puppeteer 自动化测试
└── make_icons.py      # 图标生成脚本
```

## 识别范围
| 类别 | 类型 |
|------|------|
| 流媒体 | .m3u8 (HLS)、.mpd (DASH)、.ts 分片 |
| 视频 | mp4/m4v/webm/mkv/flv/avi/mov/wmv/3gp/ogv |
| 音频 | mp3/m4a/aac/wav/ogg/opus/flac/wma |
| 图片 | jpg/png/gif/webp/bmp/svg/ico/avif |

另支持无扩展名但响应头为 `video/*`、`audio/*`、`mpegurl`、`dash+xml` 的请求。

## 已知限制
- DRM(Widevine) 无法解密；仅支持标准 HLS（AES-128 可解）
- 产物为 .ts（非 mp4）
- 超大视频合并需较多内存；CDN 强制 Referer 校验（URL 无鉴权参数）可能 403
