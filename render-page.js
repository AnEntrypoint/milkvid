'use strict';

module.exports = function buildPage(port, w, h, fps, spf, presetJson, bitrate) {
  var script = `
window._viz=null; window._enc=null; window._waveBuf=null; window._init=false; window._encErr=null;
window._segStats={spinMs:0,chunks:0,chunkBytes:0};
window._spsNals=null; window._ppsNals=null;

function avccToAnnexB(data) {
  var out=[], i=0;
  while(i+4<=data.length) {
    var len=(data[i]<<24|data[i+1]<<16|data[i+2]<<8|data[i+3])>>>0;
    i+=4;
    if(len===0||i+len>data.length) break;
    out.push(0,0,0,1);
    for(var j=0;j<len;j++) out.push(data[i+j]);
    i+=len;
  }
  return new Uint8Array(out);
}

function parseDecoderConfig(desc) {
  var d=new Uint8Array(desc);
  var spsList=[], ppsList=[], i=5;
  var numSps=d[i++]&0x1f;
  for(var s=0;s<numSps;s++){var l=(d[i]<<8|d[i+1]);i+=2;spsList.push(d.slice(i,i+l));i+=l;}
  var numPps=d[i++];
  for(var p=0;p<numPps;p++){var l=(d[i]<<8|d[i+1]);i+=2;ppsList.push(d.slice(i,i+l));i+=l;}
  var out=[];
  spsList.forEach(function(n){out.push(0,0,0,1);n.forEach(function(b){out.push(b);});});
  ppsList.forEach(function(n){out.push(0,0,0,1);n.forEach(function(b){out.push(b);});});
  return new Uint8Array(out);
}

window.initRender = async function() {
  if(window._init) return true;
  var c=document.getElementById('c'); c.width=${w}; c.height=${h};
  var gl=c.getContext('webgl2',{alpha:false,antialias:false,depth:false,stencil:false,premultipliedAlpha:false,preserveDrawingBuffer:true});
  if(!gl){console.error('[enc] no webgl2');return false;}
  window._canvas=c;
  var ac=new AudioContext();
  window._viz=butterchurn.default.createVisualizer(ac,c,{width:${w},height:${h},meshWidth:32,meshHeight:24,pixelRatio:1.0});
  window._viz.loadPreset(JSON.parse(${JSON.stringify(presetJson)}),0.0);
  console.log('[enc] fetching waveforms...');
  var r=await fetch('http://127.0.0.1:${port}/waveforms');
  window._waveBuf=new Uint8Array(await r.arrayBuffer());
  console.log('[enc] waveforms loaded:',window._waveBuf.length,'bytes');
  window._enc=new VideoEncoder({
    output: async function(chunk, meta) {
      var b=new Uint8Array(chunk.byteLength); chunk.copyTo(b);
      var annexB=avccToAnnexB(b);
      var payload=annexB;
      if(chunk.type==='key') {
        if(meta && meta.decoderConfig && meta.decoderConfig.description) {
          window._spsNals=parseDecoderConfig(meta.decoderConfig.description);
        }
        if(window._spsNals) {
          var combined=new Uint8Array(window._spsNals.length+annexB.length);
          combined.set(window._spsNals,0); combined.set(annexB,window._spsNals.length);
          payload=combined;
        }
      }
      window._segStats.chunks++; window._segStats.chunkBytes+=payload.length;
      try {
        await fetch('http://127.0.0.1:${port}/chunk',{method:'POST',body:payload,headers:{'Content-Type':'application/octet-stream'}});
      } catch(e){window._encErr='chunk POST failed: '+e.message;}
    },
    error: function(e){window._encErr=e.message; console.error('[enc] error:',e.message);}
  });
  var cfgs=[
    {codec:'avc1.64001f',width:${w},height:${h},bitrate:${bitrate},framerate:${fps},hardwareAcceleration:'prefer-hardware'},
    {codec:'avc1.64001f',width:${w},height:${h},bitrate:${bitrate},framerate:${fps},hardwareAcceleration:'prefer-software'},
    {codec:'avc1.42001f',width:${w},height:${h},bitrate:${bitrate},framerate:${fps},hardwareAcceleration:'prefer-software'}
  ];
  for(var ci=0;ci<cfgs.length;ci++){
    try{var s=await VideoEncoder.isConfigSupported(cfgs[ci]);if(s.supported){window._enc.configure(cfgs[ci]);console.log('[enc] configured:',cfgs[ci].codec,cfgs[ci].hardwareAcceleration);break;}}catch(e){}
  }
  var sw=new Uint8Array(${spf}).fill(128);
  for(var wi=0;wi<10;wi++) window._viz.render({audioLevels:{timeByteArray:sw,timeByteArrayL:sw,timeByteArrayR:sw},elapsedTime:wi/${fps}});
  console.log('[enc] warmup done, encoding ${fps}fps');
  window._init=true;
  return true;
};

window.renderSegment = async function(s, e, warmupOnly) {
  var viz=window._viz, enc=window._enc, wav=window._waveBuf;
  window._segStats={spinMs:0,chunks:0,chunkBytes:0};
  var t0seg=performance.now();
  for(var f=s;f<e;f++){
    if(window._encErr) return {ok:false,error:window._encErr};
    var wave=wav.subarray(f*${spf},(f+1)*${spf});
    viz.render({audioLevels:{timeByteArray:wave,timeByteArrayL:wave,timeByteArrayR:wave},elapsedTime:f/${fps}});
    if(!warmupOnly){
      var spinT=performance.now();
      while(enc.encodeQueueSize>5) await new Promise(function(r){setTimeout(r,1);});
      window._segStats.spinMs+=performance.now()-spinT;
      var frame=new VideoFrame(window._canvas,{timestamp:Math.round(f*1000000/${fps})});
      enc.encode(frame,{keyFrame:f%${fps*2}===0});
      frame.close();
      if((f+1)%${fps}===0) await window.onProgress(f+1);
    } else if((f+1)%200===0) await new Promise(function(r){setTimeout(r,0);});
  }
  if(!warmupOnly){ await enc.flush(); await window.onProgress(e); }
  return {ok:true,segMs:performance.now()-t0seg,spinMs:window._segStats.spinMs,chunks:window._segStats.chunks,chunkBytes:window._segStats.chunkBytes};
};`;

  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;overflow:hidden">
<canvas id="c"></canvas>
<script src="http://127.0.0.1:${port}/butterchurn.js"></script>
<script>${script}</script></body></html>`;
};
