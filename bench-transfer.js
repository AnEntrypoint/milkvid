'use strict';
var fs = require('fs');
var puppeteer = require('puppeteer');

var WIDTH = 1280, HEIGHT = 720, FPS = 30;
var PRESET_FILE = 'C:/dev/milkvid/presets/Aderrasi - Mother Of Pearl - mash0000 - how to piss off your eyes.json';
var TEST_FRAMES = 30;

async function main() {
  var preset = JSON.parse(fs.readFileSync(PRESET_FILE, 'utf8'));
  var butterchurnSrc = fs.readFileSync('C:/dev/milkvid/node_modules/butterchurn/lib/butterchurn.min.js', 'utf8');

  var browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox','--disable-setuid-sandbox','--enable-webgl','--ignore-gpu-blocklist','--use-gl=angle',
           '--disable-background-timer-throttling','--disable-renderer-backgrounding',
           '--window-size=' + WIDTH + ',' + HEIGHT]
  });
  var page = await browser.newPage();
  page.on('console', function(m) { var t=m.text(); if(t.indexOf('error')>-1||t.indexOf('Error')>-1) console.log('B:',t); });
  page.on('pageerror', function(e) { console.log('PE:',e.message); });
  await page.setViewport({ width: WIDTH, height: HEIGHT });

  var html = '<!DOCTYPE html><html><body style="margin:0;overflow:hidden"><canvas id="c"></canvas><script>' + butterchurnSrc + '</script><script>\n' +
    'window.initViz = function(w,h,pj) {\n' +
    '  var canvas=document.getElementById("c"); canvas.width=w; canvas.height=h; window._canvas=canvas;\n' +
    '  var gl=canvas.getContext("webgl2",{alpha:false,antialias:false,depth:false,stencil:false,premultipliedAlpha:false,preserveDrawingBuffer:true});\n' +
    '  if(!gl) return "error:no webgl2";\n' +
    '  window._gl=gl; window._w=w; window._h=h;\n' +
    '  var audioCtx=new(window.AudioContext||window.webkitAudioContext)();\n' +
    '  var viz=butterchurn.default.createVisualizer(audioCtx,canvas,{width:w,height:h,meshWidth:32,meshHeight:24,pixelRatio:1.0});\n' +
    '  viz.loadPreset(JSON.parse(pj),0.0);\n' +
    '  window._viz=viz;\n' +
    '  window._rawbuf=new Uint8Array(w*h*4);\n' +
    '  window._flipbuf=new Uint8Array(w*h*4);\n' +
    '  return "ok";\n' +
    '};\n' +
    // chunked btoa to avoid stack overflow on large arrays
    'function toBase64Chunked(u8) {\n' +
    '  var CHUNK=8192, parts=[], len=u8.length;\n' +
    '  for(var i=0;i<len;i+=CHUNK) parts.push(String.fromCharCode.apply(null,u8.subarray(i,i+CHUNK)));\n' +
    '  return btoa(parts.join(""));\n' +
    '}\n' +
    'window.renderFrame = function(waveArr, t) {\n' +
    '  var arr=new Uint8Array(waveArr);\n' +
    '  window._viz.render({audioLevels:{timeByteArray:arr,timeByteArrayL:arr,timeByteArrayR:arr},elapsedTime:t});\n' +
    '  var gl=window._gl, w=window._w, h=window._h, row=w*4;\n' +
    '  gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,window._rawbuf);\n' +
    '  for(var y=0;y<h;y++) window._flipbuf.set(window._rawbuf.subarray((h-1-y)*row,(h-y)*row),y*row);\n' +
    '  return toBase64Chunked(window._flipbuf);\n' +
    '};\n' +
    '</script></body></html>';

  await page.setContent(html);
  var r = await page.evaluate(function(w,h,p){return window.initViz(w,h,p);}, WIDTH, HEIGHT, JSON.stringify(preset));
  console.log('initViz:', r);
  if (r.startsWith('error:')) throw new Error(r);

  var wave = Array.from({length:512}, function(_,i){return Math.floor(128+60*Math.sin(i*0.1));});
  for (var i=0;i<5;i++) await page.evaluate(function(w,t){return window.renderFrame(w,t);}, wave, i/FPS);

  var t0 = Date.now();
  var totalBytes = 0;
  for (var f=0; f<TEST_FRAMES; f++) {
    var b64 = await page.evaluate(function(w,t){return window.renderFrame(w,t);}, wave, f/FPS);
    var buf = Buffer.from(b64, 'base64');
    totalBytes += buf.length;
    if (f===0) console.log('Frame 0 buf size:', buf.length, 'expected:', WIDTH*HEIGHT*4);
  }
  var elapsed = (Date.now()-t0)/1000;
  console.log('Frames:', TEST_FRAMES, 'in', elapsed.toFixed(2)+'s =', (TEST_FRAMES/elapsed).toFixed(2), 'fps');
  console.log('Total bytes:', totalBytes);
  await browser.close();
}

main().catch(function(e){console.error('FAIL:',e.message,e.stack);process.exit(1);});
