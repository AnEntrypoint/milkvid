'use strict';
var fs = require('fs');
var http = require('http');
var path = require('path');
var spawn = require('child_process').spawn;
var puppeteer = require('puppeteer');
var buildPage = require('./render-page');

function parseArgs() {
  var args = process.argv.slice(2), out = {};
  args.forEach(function(a, i) {
    var m = a.match(/^--(\w+)=(.+)$/);
    if (m) { out[m[1]] = m[2]; return; }
    m = a.match(/^--(\w+)$/);
    if (m && i + 1 < args.length) out[m[1]] = args[i + 1];
  });
  return out;
}
var A = parseArgs();
var WIDTH       = parseInt(A.width   || '1280', 10);
var HEIGHT      = parseInt(A.height  || '720',  10);
var FPS         = parseInt(A.fps     || '30',   10);
var BITRATE     = parseInt(A.bitrate || '4000000', 10);
var AUDIO_FILE  = A.audio  || 'C:/Users/user/Downloads/untitled.wav';
var PRESET_FILE = A.preset || 'C:/dev/milkvid/presets/Aderrasi - Mother Of Pearl - mash0000 - how to piss off your eyes.json';
var OUTPUT_FILE = A.output || 'C:/dev/milkvid/output/aderrasi-mother-of-pearl.mp4';
var CHECKPOINT  = path.join(path.dirname(OUTPUT_FILE), 'render-checkpoint.json');
var SPF         = 512;
var PORT        = 19876;
var SEG         = 2000;

var CHROME_ARGS = [
  '--no-sandbox','--disable-setuid-sandbox',
  '--enable-webgl','--ignore-gpu-blocklist',
  '--use-gl=angle','--use-angle=d3d11',
  '--enable-gpu-memory-buffer-video-frames','--enable-native-gpu-memory-buffers',
  '--disable-background-timer-throttling','--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--window-size='+WIDTH+','+HEIGHT
];

function readWav(file) {
  var buf = fs.readFileSync(file);
  var sr = buf.readUInt32LE(24), ch = buf.readUInt16LE(22), bps = buf.readUInt16LE(34);
  var off = 12;
  while (off < buf.length - 8) { var id = buf.toString('ascii',off,off+4), sz = buf.readUInt32LE(off+4); if (id==='data'){off+=8;break;} off+=8+sz; }
  var n = Math.floor((buf.length-off)/(bps/8)/ch);
  var s = new Int16Array(n);
  for (var i=0;i<n;i++) s[i] = bps===16 ? buf.readInt16LE(off+i*(bps/8)*ch) : (buf.readUInt8(off+i)-128)*256;
  return { samples: s, sampleRate: sr, duration: n/sr };
}

function buildWaveforms(samples, sr, totalFrames) {
  var data = Buffer.allocUnsafe(totalFrames * SPF);
  for (var f=0;f<totalFrames;f++) {
    var start = Math.floor(f * sr / FPS);
    for (var i=0;i<SPF;i++) {
      var v = (start+i) < samples.length ? samples[start+i]/32768.0 : 0;
      data[f*SPF+i] = Math.max(0,Math.min(255,Math.floor((v+1)*128)));
    }
  }
  return data;
}

function readCheckpoint() { try { return JSON.parse(fs.readFileSync(CHECKPOINT,'utf8')); } catch(e) { return null; } }
function saveCheckpoint(n) { fs.writeFileSync(CHECKPOINT, JSON.stringify({framesRendered:n})); }

function makeChunkHandler(ffprocRef, stats) {
  return function(req, res) {
    var parts = [];
    req.on('data', function(d){ parts.push(d); });
    req.on('end', function() {
      var buf = Buffer.concat(parts);
      stats.count++; stats.bytes += buf.length;
      var proc = ffprocRef.proc;
      if (!proc || !proc.stdin.writable) { res.writeHead(503); res.end(); return; }
      if (!proc.stdin.write(buf)) proc.stdin.once('drain', function(){ res.writeHead(200); res.end(); });
      else { res.writeHead(200); res.end(); }
    });
  };
}

async function main() {
  fs.mkdirSync(path.dirname(OUTPUT_FILE), {recursive:true});
  console.log('Loading audio...');
  var audio = readWav(AUDIO_FILE);
  var totalFrames = Math.ceil(audio.duration * FPS);
  console.log('Audio: '+audio.duration.toFixed(1)+'s, '+totalFrames+' frames');

  var checkpoint = readCheckpoint();
  var resumeFrom = checkpoint ? checkpoint.framesRendered : 0;
  if (resumeFrom > 0) console.log('Resuming from frame '+resumeFrom);

  console.log('Building waveforms...');
  var waveData = buildWaveforms(audio.samples, audio.sampleRate, totalFrames);
  audio.samples = null;

  var preset = JSON.parse(fs.readFileSync(PRESET_FILE, 'utf8'));
  var bcSrc = fs.readFileSync(path.join(__dirname, 'node_modules/butterchurn/lib/butterchurn.min.js'), 'utf8');
  var pageHtml = buildPage(PORT, WIDTH, HEIGHT, FPS, SPF, JSON.stringify(preset), BITRATE);

  var MKV_FILE   = OUTPUT_FILE.replace(/\.mp4$/, '.mkv');
  var mkvTarget  = resumeFrom > 0 ? MKV_FILE+'.part' : MKV_FILE;
  var ffprocRef  = {proc: null};
  var chunkStats = {count:0, bytes:0};

  var srv = await new Promise(function(resolve) {
    var chunkHandler = makeChunkHandler(ffprocRef, chunkStats);
    var s = http.createServer(function(req, res) {
      if (req.url==='/butterchurn.js') { res.writeHead(200,{'Content-Type':'application/javascript','Content-Length':Buffer.byteLength(bcSrc)}); res.end(bcSrc); }
      else if (req.url==='/waveforms') { res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':waveData.length}); res.end(waveData); }
      else if (req.method==='POST' && req.url==='/chunk') { chunkHandler(req,res); }
      else { var h=Buffer.from(pageHtml); res.writeHead(200,{'Content-Type':'text/html','Content-Length':h.length}); res.end(h); }
    });
    s.listen(PORT,'127.0.0.1',function(){resolve(s);});
  });

  ffprocRef.proc = spawn('ffmpeg', [
    '-y','-f','h264','-r',String(FPS),
    '-i','pipe:0',
    '-i',AUDIO_FILE,
    '-c:v','copy','-c:a','aac','-b:a','192k','-shortest',
    mkvTarget
  ]);
  ffprocRef.proc.stdin.setMaxListeners(0);
  ffprocRef.proc.stderr.on('data', function(d){ var s=d.toString(); if(s.includes('frame=')||s.includes('rror')||s.includes('dimension')) process.stderr.write(s); });
  var ffDone = new Promise(function(res,rej){ ffprocRef.proc.on('close',function(c){c===0?res():rej(new Error('ffmpeg exit '+c));}); });

  var t0=Date.now(), lastLog=t0;
  var browser = await puppeteer.launch({headless:true, protocolTimeout:0, args:CHROME_ARGS});
  var page = await browser.newPage();
  page.on('console', function(m){ var t=m.text(); if(t.includes('[enc]')||t.includes('rror')) console.log('BROWSER:',t); });
  page.on('pageerror', function(e){ console.error('PAGE ERROR:',e.message); });
  await page.setViewport({width:WIDTH, height:HEIGHT});
  await page.exposeFunction('onProgress', function(frame) {
    var now=Date.now();
    if(now-lastLog>=5000){
      var el=(now-t0)/1000, done=frame-resumeFrom;
      var fps=done>0?done/el:0, rem=fps>0?(totalFrames-frame)/fps:0;
      console.log('Frame '+frame+'/'+totalFrames+' ('+((frame/totalFrames)*100).toFixed(1)+'%) | '+fps.toFixed(1)+' fps | ETA '+(rem/3600).toFixed(2)+'hr | '+(chunkStats.bytes/1024/1024).toFixed(1)+'MB | '+(chunkStats.count/((now-t0)/1000)).toFixed(1)+' chunks/s');
      lastLog=now;
    }
  });

  console.log('Starting encode...');
  await page.goto('http://127.0.0.1:'+PORT+'/');
  var ok = await page.evaluate(function(){ return window.initRender(); });
  if (!ok) throw new Error('initRender failed');

  if (resumeFrom > 0) {
    console.log('Warming up to frame '+resumeFrom+'...');
    for (var ws=0; ws<resumeFrom; ws+=SEG) {
      await page.evaluate(function(s,e){ return window.renderSegment(s,e,true); }, ws, Math.min(ws+SEG,resumeFrom));
      process.stdout.write('\rWarmup: '+Math.min(ws+SEG,resumeFrom)+'/'+resumeFrom+'   ');
    }
    console.log('\nWarmup done.');
  }

  var totSpin=0,totBytes=0,totChunks=0;
  for (var seg=resumeFrom; seg<totalFrames; seg+=SEG) {
    var segEnd=Math.min(seg+SEG,totalFrames), segT0=Date.now();
    var res=await page.evaluate(function(s,e){return window.renderSegment(s,e,false);},seg,segEnd);
    if(!res||!res.ok) throw new Error('Segment failed: '+(res&&res.error));
    totSpin+=(res.spinMs||0); totBytes+=(res.chunkBytes||0); totChunks+=(res.chunks||0);
    console.log('Seg '+seg+'->'+segEnd+' | wall='+(Date.now()-segT0)+'ms spin='+Math.round(res.spinMs||0)+'ms chunks='+res.chunks+' chunkKB='+((res.chunkBytes||0)/1024).toFixed(0));
    saveCheckpoint(segEnd);
    if(typeof gc!=='undefined') gc();
    seg=segEnd-SEG;
  }
  console.log('Encode done. spin='+Math.round(totSpin)+'ms chunks='+totChunks+' data='+(totBytes/1024/1024).toFixed(1)+'MB');
  ffprocRef.proc.stdin.end();
  await ffDone;

  var mkvStat = fs.statSync(mkvTarget);
  console.log('MKV: '+mkvTarget+' ('+(mkvStat.size/1024/1024).toFixed(1)+' MB)');

  if (resumeFrom > 0) {
    var part=MKV_FILE+'.part', concat=MKV_FILE+'.concat.txt', trimmed=MKV_FILE+'.trimmed.mkv', merged=MKV_FILE+'.merged.mkv';
    await new Promise(function(res,rej){ var p=spawn('ffmpeg',['-y','-i',MKV_FILE,'-t',(resumeFrom/FPS).toFixed(6),'-c','copy',trimmed]); p.on('close',function(c){c===0?res():rej(new Error('trim '+c));});});
    fs.writeFileSync(concat,"file '"+trimmed+"'\nfile '"+part+"'\n");
    await new Promise(function(res,rej){ var p=spawn('ffmpeg',['-y','-f','concat','-safe','0','-i',concat,'-c','copy',merged]); p.on('close',function(c){c===0?res():rej(new Error('merge '+c));});});
    fs.renameSync(merged, MKV_FILE);
    [part,concat,trimmed].forEach(function(f){try{fs.unlinkSync(f);}catch(e){}});
  }

  console.log('Remuxing MKV -> MP4...');
  await new Promise(function(res,rej){
    var p=spawn('ffmpeg',['-y','-i',MKV_FILE,'-c','copy','-movflags','+faststart',OUTPUT_FILE]);
    p.stderr.on('data',function(d){var s=d.toString();if(s.includes('rror'))process.stderr.write(s);});
    p.on('close',function(c){c===0?res():rej(new Error('remux exit '+c));});
  });

  try{fs.unlinkSync(MKV_FILE);}catch(e){}
  try{fs.unlinkSync(CHECKPOINT);}catch(e){}
  srv.close(); await browser.close();
  var stat=fs.statSync(OUTPUT_FILE);
  console.log('Done in '+((Date.now()-t0)/1000).toFixed(0)+'s — '+OUTPUT_FILE+' ('+(stat.size/1024/1024).toFixed(1)+' MB)');
}

main().catch(function(e){ console.error('FAIL:',e.message); process.exit(1); });
