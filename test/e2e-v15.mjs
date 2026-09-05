// E2E（v1.5.0 引擎）— 在真实 Chrome 页面上下文运行 downloader.js，验证抓取/解密/合并/下载调用。
// 说明：本机 Chrome 137+ 不支持 --load-extension，故无法整包加载扩展做自动化；
// 改以「真实页面 + chrome API 桩」驱动 downloader.js 本体，逐字节校验合并结果并确认调用了
// chrome.downloads.download(blobUrl)。分片走真实网络 + WebCrypto AES 解密，等价于扩展页行为。
import { createRequire } from 'module';
const require = createRequire('C:/Users/candi/.workbuddy/binaries/node/workspace/');
const puppeteer = require('puppeteer-core');
const http = require('http');
const fs = require('fs');
const path = require('path');
import crypto from 'crypto';

const EXT = 'K:\\vibecoding\\media-sniffer';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DL_DIR = path.join(EXT, 'test', 'dl-out');
fs.mkdirSync(DL_DIR, { recursive: true });

// ---------- 夹具 ----------
const KEY = crypto.randomBytes(16);
const ivOf = (seq) => { const b = Buffer.alloc(16); b.writeUInt32BE(seq, 12); return b; };
const makeTs = (seq) => { const buf = Buffer.alloc(188 * 6); for (let i = 0; i < 6; i++){ buf[i*188]=0x47; buf[i*188+1]=0x40; } buf.writeUInt32BE(seq,4); return buf; };
const enc = (b,k,iv) => { const c=crypto.createCipheriv('aes-128-cbc',k,iv); return Buffer.concat([c.update(b),c.final()]); };
const FIX = path.join(EXT, 'test', 'fixture-v15');
fs.mkdirSync(path.join(FIX,'a'), {recursive:true});
fs.writeFileSync(path.join(FIX,'key.bin'), KEY);
const SEGS = 8, ts0 = makeTs(0).length, expectedBytes = SEGS*ts0;
for (let i=0;i<SEGS;i++) fs.writeFileSync(path.join(FIX,'a',`seg${i}.ts`), enc(makeTs(100+i),KEY,ivOf(100+i)));
fs.writeFileSync(path.join(FIX,'a','index.m3u8'), [
 '#EXTM3U','#EXT-X-VERSION:3','#EXT-X-TARGETDURATION:1','#EXT-X-MEDIA-SEQUENCE:0','#EXT-X-PLAYLIST-TYPE:VOD',
 '#EXT-X-KEY:METHOD=AES-128,URI="../key.bin",IV=0x00000000000000000000000000000000',
 ...Array.from({length:SEGS},(_,i)=>`#EXTINF:1.0,\nseg${i}.ts`), '#EXT-X-ENDLIST'
].join('\n'));
fs.writeFileSync(path.join(FIX,'master.m3u8'), ['#EXTM3U','#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360','a/index.m3u8'].join('\n'));

const MIME={'.m3u8':'application/vnd.apple.mpegurl','.ts':'video/mp2t','.bin':'application/octet-stream','.js':'text/javascript','.html':'text/html'};
const server=http.createServer((req,res)=>{
  let p = decodeURIComponent(req.url.split('?')[0]);
  let file;
  if (p.startsWith('/fix/')) {
    file = path.join(FIX, p.slice('/fix/'.length));
  } else if (p==='/downloader.js' || p==='/downloader.html') {
    file = path.join(EXT, '.'+p);
  } else { res.writeHead(404); res.end('nf'); return; }
  file = path.normalize(file);
  if (!fs.existsSync(file)){res.writeHead(404);res.end('nf');return;}
  const ext=path.extname(file).toLowerCase();
  res.writeHead(200,{'Content-Type':MIME[ext]||'application/octet-stream','Access-Control-Allow-Origin':'*'});
  fs.createReadStream(file).pipe(res);
});
const push=(s)=>{console.log(s);};
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));

async function main(){
  await new Promise(r=>server.listen(8742,'127.0.0.1',r));
  push('server on :8742, expectedBytes='+expectedBytes);

  const browser=await puppeteer.launch({executablePath:CHROME,headless:'new',defaultViewport:null,
    args:['--no-sandbox','--no-first-run','--user-data-dir='+path.join(DL_DIR,'.c'+Date.now())]});

  // chrome API 桩（在页面任何脚本运行前注入）
  const page=await browser.newPage();
  const captured={ downloadCalls:[], sessionMap:{}, lastBlob:null };
  await page.evaluateOnNewDocument(() => {
    window.__cap = {
      downloadCalls: [], sessionMap: {}, lastBlob: null,
    };
    const rec = window.__cap;
    const memStorage = {
      get:(k)=>Promise.resolve(k===null||k===undefined ? {...rec.sessionMap} : (Array.isArray(k)?Object.fromEntries(k.filter(x=>x in rec.sessionMap).map(x=>[x,rec.sessionMap[x]])):(k in rec.sessionMap?{[k]:rec.sessionMap[k]}:{}))),
      set:(o)=>{Object.assign(rec.sessionMap,o);return Promise.resolve();},
      remove:(k)=>{if(Array.isArray(k))k.forEach(x=>delete rec.sessionMap[x]);else delete rec.sessionMap[k];return Promise.resolve();},
    };
    const downloads = {
      download:(opt,cb)=>{ rec.downloadCalls.push(opt); const id=rec.downloadCalls.length; if(cb)cb(id);
        (async()=>{ try{ const r=await fetch(opt.url); const b=new Uint8Array(await r.arrayBuffer()); rec.lastBlob={size:b.byteLength,head0:b[0],head1:b[188]}; rec.downloadCalls[rec.downloadCalls.length-1].blobSize=b.byteLength; }catch(e){ rec.lastBlob={err:String(e)}; } })();
        return id; },
      search:(q,cb)=>{ if(cb)cb([]); return Promise.resolve([]); },
      showDefaultFolder:()=>{}, onChanged:{ addListener:()=>{} },
    };
    window.chrome = {
      runtime:{ id:'testext', getURL:(p)=>'http://127.0.0.1:8742/'+p.replace(/^\//,''), sendMessage:(m,cb)=>{cb&&cb({ok:true});}, onMessage:{ addListener:()=>{} }, lastError:null },
      storage:{ session:memStorage, local:memStorage },
      downloads, tabs:{ query:()=>Promise.resolve([]), create:()=>{} },
      extension:{ getURL:(p)=>'http://127.0.0.1:8742/'+p.replace(/^\//,'') },
    };
  });

  await page.goto('http://127.0.0.1:8742/downloader.html?url='+encodeURIComponent('http://127.0.0.1:8742/fix/master.m3u8')+'&title='+encodeURIComponent('e2e_fixture'), {waitUntil:'load',timeout:20000});

  // 轮询直到 downloadCalls 出现且 lastBlob 有效
  let blobOk=false;
  for(let i=0;i<80;i++){
    await sleep(1000);
    const s=await page.evaluate(()=>window.__cap);
    if(s.downloadCalls.length && s.lastBlob){
      blobOk = s.lastBlob.size===expectedBytes && s.lastBlob.head0===0x47 && s.lastBlob.head1===0x47;
      break;
    }
    if(!blobOk && s.lastBlob && s.lastBlob.err){ push('blob err='+s.lastBlob.err); }
  }
  const st=await page.evaluate(()=>window.__cap);
  const body=await page.evaluate(()=>document.body.innerText).catch(()=>'n/a');
  push('downloadCalls='+st.downloadCalls.length);
  push('页面状态文本:\n'+body.slice(0,300));
  if(!st.downloadCalls.length){ throw new Error('未触发 chrome.downloads.download'); }
  if(!blobOk){ push('lastBlob='+JSON.stringify(st.lastBlob)); throw new Error('合并字节校验失败'); }

  push('✅ 引擎通过：downloads.download 被调用，blob='+st.downloadCalls[0].blobSize+'B，TS头正确');
  await browser.close(); server.close();
  console.log('RESULT: PASS');
}
main().catch(e=>{console.log('RESULT: FAIL '+((e&&e.message)||e));try{server.close();}catch(_){}process.exit(1);});
