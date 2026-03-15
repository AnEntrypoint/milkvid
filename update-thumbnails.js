'use strict';

const fs   = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const PRESETS_DIR = 'C:/dev/milkvid/presets';
const THUMBS_DIR  = 'C:/dev/milkvid/thumbnails';
const AUDIO_FILE  = 'C:/Users/user/Downloads/untitled.wav';
const WIDTH       = 320;
const HEIGHT      = 240;
const CAPTURE_SEC = 4;
const FPS         = 30;
const MESH_W      = 24;
const MESH_H      = 18;
const JPEG_Q      = 0.85;
const NUM_WORKERS = 8;
const BATCH_SIZE  = 20; // presets rendered per page before recycling

const CHROME_ARGS = [
  '--no-sandbox', '--disable-setuid-sandbox',
  '--enable-webgl', '--ignore-gpu-blocklist',
  '--use-gl=angle', '--use-angle=d3d11',
  '--enable-gpu-rasterization', '--enable-zero-copy',
  '--disable-software-rasterizer',
  `--window-size=${WIDTH},${HEIGHT}`,
];

const BC_SRC = fs.readFileSync('./node_modules/butterchurn/lib/butterchurn.min.js', 'utf8');

function parseWav(filePath) {
  const buf = fs.readFileSync(filePath);
  let off = 12;
  while (off < buf.length - 8) {
    const id = buf.slice(off, off + 4).toString();
    const sz = buf.readUInt32LE(off + 4);
    if (id === 'data') { off += 8; break; }
    off += 8 + sz;
  }
  const sr = buf.readUInt32LE(24), bps = buf.readUInt16LE(34), ch = buf.readUInt16LE(22);
  const n = Math.floor((buf.length - off) / (bps / 8) / ch);
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) s[i] = bps === 16 ? buf.readInt16LE(off + i * (bps / 8) * ch) / 32768 : 0;
  return { samples: s, sampleRate: sr };
}

function buildWaveform(samples, offset, size) {
  const arr = new Array(size);
  for (let i = 0; i < size; i++) {
    const s = samples[offset + i] || 0;
    arr[i] = Math.max(0, Math.min(255, Math.floor((s + 1) * 127.5)));
  }
  return arr;
}

function walkPresets(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...walkPresets(full));
    else if (entry.name.endsWith('.json') || entry.name.endsWith('.milk')) results.push(full);
  }
  return results;
}

function thumbPath(presetFile) {
  const rel = path.relative(PRESETS_DIR, presetFile);
  return path.join(THUMBS_DIR, rel.replace(/\.(json|milk)$/, '.jpg'));
}

const PAGE_HTML = `<!DOCTYPE html><html><body style="margin:0;overflow:hidden;background:black">
<canvas id="c"></canvas>
<script>${BC_SRC}</script>
<script>
let _viz = null;
const _c = document.getElementById('c');
_c.width = ${WIDTH}; _c.height = ${HEIGHT};
_c.getContext('webgl2',{alpha:false,antialias:false,depth:false,stencil:false,premultipliedAlpha:false,preserveDrawingBuffer:true});

window.initViz = function() {
  _viz = butterchurn.default.createVisualizer(new AudioContext(), _c, {
    width:${WIDTH}, height:${HEIGHT}, meshWidth:${MESH_W}, meshHeight:${MESH_H}, pixelRatio:1.0
  });
};

window.renderPreset = function(presetJson, waveforms) {
  _viz.loadPreset(presetJson, 0.0);
  const captureIdx = waveforms.length - 1;
  for (let i = 0; i < waveforms.length; i++) {
    const arr = new Uint8Array(waveforms[i]);
    const t = i / ${FPS};
    _viz.render({audioLevels:{timeByteArray:arr,timeByteArrayL:arr,timeByteArrayR:arr},elapsedTime:t});
  }
  return _c.toDataURL('image/jpeg', ${JPEG_Q});
};
</script></body></html>`;

async function makeWorkerPage(browser) {
  const page = await browser.newPage();
  await page.setViewport({ width: WIDTH, height: HEIGHT });
  await page.setContent(PAGE_HTML);
  await page.evaluate(() => window.initViz());
  return page;
}

async function worker(browser, queue, force, stats, audioData) {
  const captureFrames = Math.floor(CAPTURE_SEC * FPS) + 1;
  // Pre-build all waveforms for capture window once
  const waveforms = [];
  for (let f = 0; f < captureFrames; f++) {
    waveforms.push(buildWaveform(audioData.samples, f * audioData.spf, 512));
  }

  let page = await makeWorkerPage(browser);
  let batchCount = 0;

  while (queue.length > 0) {
    const presetFile = queue.shift();
    const out = thumbPath(presetFile);

    if (!force && fs.existsSync(out)) {
      stats.skipped++;
      printProgress(stats, path.basename(presetFile), 'skip');
      continue;
    }

    try {
      const presetJson = JSON.parse(fs.readFileSync(presetFile, 'utf8'));
      const dataUrl = await page.evaluate((p, w) => window.renderPreset(p, w), presetJson, waveforms);
      const buf = Buffer.from(dataUrl.slice('data:image/jpeg;base64,'.length), 'base64');
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, buf);
      stats.done++;
      batchCount++;
    } catch (e) {
      stats.errors++;
      process.stdout.write('\n');
      console.error(`ERROR: ${path.basename(presetFile)}: ${e.message}`);
    }

    printProgress(stats, path.basename(presetFile), 'render');

    // Recycle page periodically to avoid memory buildup
    if (batchCount >= BATCH_SIZE) {
      await page.close();
      page = await makeWorkerPage(browser);
      batchCount = 0;
    }
  }

  await page.close();
}

function printProgress(stats, name, action) {
  const total = stats.done + stats.skipped + stats.errors;
  const pct = Math.round(total / stats.total * 100);
  const label = action === 'skip' ? 'skip' : action === 'render' ? 'done' : 'err';
  process.stdout.write(`\r[${total}/${stats.total}] ${pct}% [${label}] ${name.slice(0, 60)}     `);
}

async function main() {
  const force    = process.argv.includes('--force');
  const limitArg = process.argv.find(a => a.startsWith('--limit='));
  const limit    = limitArg ? parseInt(limitArg.split('=')[1], 10) : Infinity;

  if (!fs.existsSync(PRESETS_DIR)) { console.error('presets dir not found:', PRESETS_DIR); process.exit(1); }
  if (!fs.existsSync(AUDIO_FILE))  { console.error('audio file not found:', AUDIO_FILE); process.exit(1); }
  fs.mkdirSync(THUMBS_DIR, { recursive: true });

  console.log('Parsing WAV...');
  const { samples, sampleRate } = parseWav(AUDIO_FILE);
  const spf = Math.floor(sampleRate / FPS);
  const audioData = { samples, spf };

  let files = walkPresets(PRESETS_DIR);
  if (files.length === 0) { console.log('No presets found.'); return; }
  if (isFinite(limit)) files = files.slice(0, limit);

  const nWorkers = Math.min(NUM_WORKERS, files.length);
  console.log(`Found ${files.length} preset(s). Workers: ${nWorkers}. Force: ${force}`);

  const queue  = [...files];
  const stats  = { done: 0, skipped: 0, errors: 0, total: files.length };

  const browsers = await Promise.all(
    Array.from({ length: nWorkers }, () => puppeteer.launch({ headless: true, args: CHROME_ARGS }))
  );

  const t0 = Date.now();
  await Promise.all(browsers.map(b => worker(b, queue, force, stats, audioData)));
  await Promise.all(browsers.map(b => b.close()));

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  process.stdout.write('\n');
  console.log(`Done. rendered=${stats.done} skipped=${stats.skipped} errors=${stats.errors} time=${elapsed}s`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
