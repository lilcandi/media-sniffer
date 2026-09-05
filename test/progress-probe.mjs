// 验证慢下载期间 getMergeProgress 能持续读到（模拟真实站点大文件）
import { createRequire } from 'module';
const require = createRequire('C:/Users/candi/.workbuddy/binaries/node/workspace/');
const puppeteer = require('puppeteer-core');
const http = require('http');
const fs = require('fs');
const path = require('path');
import crypto from 'crypto';
const EXT = 'K:\\vibecoding\\media-sniffer';
const DIR = 'K:\\vibecoding\\media-sniffer\\test\\fixture-slow';
fs.mkdirSync(DIR, { recursive: true });
const KEY = crypto.randomBytes(16);
const N = 80;
const m3u8 = ['#EXTM3U','#EXT-X-VERSION:3','#EXT-X-TARGETDURATION:2','#EXT-X-MEDIA-SEQUENCE:0','#EXT-X-PLAYLIST-TYPE:VOD','#EXT-X-KEY:METHOD=AES-128,URI="k.key",IV=0x00000000000000000000000000000000'];
for (let i=0;i<N;i++){m3u8.push('#EXTINF:2.0,', `s${i}.ts`);} m3u8.push('#EXT-X-ENDLIST');
fs.writeFileSync(path.join(DIR,'slow.m3u8'), m3u8.join('\n'));
fs.writeFileSync(path.join(DIR,'k.key'), KEY);
for (let i=0;i<N;i++){ const b=Buffer.alloc(188*30); for(let j=0;j<30;j++){b[j*188]=0x47;} const iv=Buffer.alloc(16); iv.writeUInt32BE(i,12); const c=crypto.createCipheriv('aes-128-cbc',KEY,iv); fs.writeFileSync(path.join(DIR,`s${i}.ts`), Buffer.concat([c.update(b),c.final()])); }
const MIME={'.m3u8':'application/vnd.apple.mpegurl','.ts':'video/mp2t','.key':'application/octet-stream'};
const server=http.createServer((req,res)=>{ const base=req.url.split('?')[0]; if(base==='/'){res.writeHead(200,{'Content-Type':'text/html'});res.end('<html><body>slow</body></html>');return;} setTimeout(()=>{ const f=path.join(DIR,path.basename(base)); try{const d=fs.readFileSync(f);res.writeHead(200,{'Content-Type':MIME[path.extname(f)]||'application/octet-stream'});res.end(d);}catch(e){res.writeHead(404);res.end();} }, 25); });
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const PORT = server.address().port;
const BASE='http://127.0.0.1:'+PORT;
const browser=await puppeteer.launch({executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',headless:false,args:['--disable-extensions-except='+EXT,'--load-extension='+EXT,'--no-first-run','--unsafely-treat-insecure-origin-as-secure='+BASE,'--allow-insecure-localhost']});
const log=[];const push=s=>{console.log(s);log.push(s);};
try{
  let extId=null; for(let i=0;i<30;i++){const w=browser.targets().filter(t=>t.type()==='service_worker'&&/background/.test(t.url())); if(w.length){extId=w[0].url().split('/')[2];break;} await new Promise(r=>setTimeout(r,500));}
  push('ext='+extId);
  const page=await browser.newPage(); await page.goto(BASE+'/',{waitUntil:'load'});
  const ep=await browser.newPage(); await ep.goto('chrome-extension://'+extId+'/popup.html',{waitUntil:'load'});
  const tid=await ep.evaluate(()=>new Promise(res=>{chrome.tabs.query({},ts=>{const t=(ts||[]).find(x=>x.url&&x.url.indexOf('127.0.0.1')>=0);res(t?t.id:null);});}));
  push('tabId='+tid);
  // 异步发起下载（不 await），随后用第二个 popup 采样进度
  const downloadP = ep.evaluate(({u,tid})=>new Promise(res=>{chrome.runtime.sendMessage({type:'downloadM3u8',url:u,tabId:tid,title:'慢下载测试'},r=>res(r));}),{u:BASE+'/slow.m3u8',tid});
  const ep2=await browser.newPage(); await ep2.goto('chrome-extension://'+extId+'/popup.html',{waitUntil:'load'});
  const samples=[];
  for(let i=0;i<12;i++){ await new Promise(r=>setTimeout(r,700)); const pg=await ep2.evaluate(()=>new Promise(res=>{chrome.runtime.sendMessage({type:'getMergeProgress'},r=>res(r));})); samples.push(pg&&pg.progress&&pg.progress.active?`${pg.progress.done}/${pg.progress.total}`:'(idle)'); }
  push('进度采样(700ms 间隔, 前8): '+samples.slice(0,8).join(', '));
  const ret=await downloadP; push('下载返回: '+JSON.stringify(ret).slice(0,200));
  const dl=await ep2.evaluate(()=>new Promise(res=>{chrome.downloads.search({limit:3,orderBy:['-startTime']},it=>res((it||[]).map(x=>({f:x.filename,st:x.state,b:x.bytesReceived,t:x.totalBytes}))));}));
  push('downloads: '+JSON.stringify(dl));
}catch(e){push('ERROR: '+(e.stack||e.message).slice(0,500));}finally{await browser.close().catch(()=>{});server.close();fs.writeFileSync('K:\\vibecoding\\media-sniffer\\test\\progress-probe.json',JSON.stringify(log,null,2));}
