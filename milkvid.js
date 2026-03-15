'use strict';
var fs = require('fs');
var path = require('path');
var http = require('http');
var readline = require('readline');
var { spawn, execSync } = require('child_process');

var CONFIG_FILE  = path.join(__dirname, '.milkvid-config.json');
var PRESETS_DIR  = path.join(__dirname, 'presets');
var THUMBS_DIR   = path.join(__dirname, 'thumbnails');
var OUTPUT_DIR   = path.join(__dirname, 'output');
var PICKER_PORT  = 19877;

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch(e) { return {}; }
}
function saveConfig(cfg) { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2)); }

function stripQuotes(s) { return s.replace(/^["']|["']$/g, '').trim(); }
function ask(rl, prompt) { return new Promise(function(res){ rl.question(prompt, res); }); }
function clear() { process.stdout.write('\x1b[2J\x1b[H'); }

function autoOutputName(presetFile) {
  var base = path.basename(presetFile, '.json')
    .replace(/[^a-zA-Z0-9-]+/g, '-').replace(/-+/g, '-').toLowerCase().slice(0, 60);
  return path.join(OUTPUT_DIR, base + '.mp4');
}

function buildPickerPage() {
  var thumbs = fs.readdirSync(THUMBS_DIR)
    .filter(function(f){ return f.endsWith('.jpg') && fs.statSync(path.join(THUMBS_DIR, f)).size > 1300; })
    .map(function(f){ return { file: f, name: f.replace(/\.jpg$/, '') }; });

  var groups = {};
  thumbs.forEach(function(t) {
    var k = /^[A-Za-z]/.test(t.name) ? t.name[0].toUpperCase() : '#';
    if (!groups[k]) groups[k] = [];
    groups[k].push(t);
  });
  var keys = Object.keys(groups).sort(function(a,b){ return a==='#'?-1:b==='#'?1:a.localeCompare(b); });

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<title>milkvid — pick a preset</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0a0a0a;color:#ccc;font-family:system-ui,sans-serif}
header{position:sticky;top:0;z-index:10;background:#111;padding:10px 16px;display:flex;align-items:center;gap:12px;border-bottom:1px solid #222}
h1{font-size:14px;color:#888;white-space:nowrap}
#search{flex:1;background:#1a1a1a;border:1px solid #333;border-radius:4px;color:#eee;padding:6px 10px;font-size:13px;outline:none}
#search:focus{border-color:#555}
#count{font-size:12px;color:#555;white-space:nowrap}
.alpha-nav{background:#0f0f0f;padding:6px 16px;display:flex;flex-wrap:wrap;gap:4px;border-bottom:1px solid #1a1a1a}
.alpha-nav a{color:#555;text-decoration:none;font-size:12px;padding:2px 5px;border-radius:3px}
.alpha-nav a:hover{color:#aaa;background:#1a1a1a}
.section{padding:0 16px 24px}
.section h2{font-size:11px;color:#444;letter-spacing:2px;text-transform:uppercase;padding:16px 0 8px;border-bottom:1px solid #1a1a1a;margin-bottom:12px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:6px}
.card{position:relative;cursor:pointer;border-radius:4px;overflow:hidden;background:#111;transition:transform 0.1s}
.card:hover{transform:scale(1.02)}
.card img{width:100%;aspect-ratio:4/3;object-fit:cover;display:block}
.card .label{position:absolute;bottom:0;left:0;right:0;background:linear-gradient(transparent,rgba(0,0,0,.9));padding:18px 6px 5px;font-size:10px;color:#bbb;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.card:hover .label{color:#fff}
.selected-banner{display:none;position:fixed;bottom:0;left:0;right:0;background:#1a6b2a;color:#fff;padding:14px 20px;font-size:14px;z-index:100;text-align:center}
.selected-banner.show{display:block}
.hidden{display:none!important}
</style></head><body>
<header>
  <h1>milkvid — pick a preset</h1>
  <input id="search" type="search" placeholder="filter…" autocomplete="off">
  <span id="count">${thumbs.length.toLocaleString()} presets</span>
</header>
<nav class="alpha-nav">
${keys.map(function(k){ return '<a href="#g'+k+'">'+k+'</a>'; }).join(' ')}
</nav>
${keys.map(function(k){
  return '<section class="section" id="g'+k+'"><h2>'+k+'</h2><div class="grid">'
    + groups[k].map(function(t){
        var safe = t.name.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');
        return '<div class="card" data-preset="'+safe+'" onclick="pick(this)">'
          +'<img loading="lazy" src="/thumb/'+encodeURIComponent(t.file)+'" alt="">'
          +'<div class="label">'+safe+'</div></div>';
      }).join('')
    + '</div></section>';
}).join('')}
<div class="selected-banner" id="banner"></div>
<script>
const countEl=document.getElementById('count');
const cards=Array.from(document.querySelectorAll('.card'));
document.getElementById('search').addEventListener('input',function(e){
  const q=e.target.value.trim().toLowerCase();
  let n=0;
  cards.forEach(function(c){
    const m=!q||c.dataset.preset.toLowerCase().includes(q);
    c.classList.toggle('hidden',!m);
    if(m)n++;
  });
  document.querySelectorAll('.section').forEach(function(s){
    s.classList.toggle('hidden',!s.querySelector('.card:not(.hidden)'));
  });
  countEl.textContent=q?(n.toLocaleString()+' / '+cards.length.toLocaleString()+' presets'):(cards.length.toLocaleString()+' presets');
});
function pick(el){
  const name=el.dataset.preset;
  document.getElementById('banner').textContent='Selected: '+name+' — return to terminal';
  document.getElementById('banner').className='selected-banner show';
  fetch('/select',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({preset:name})});
}
</script></body></html>`;
}

function openBrowser(url) {
  try { execSync('start "" "' + url + '"', {shell: true}); } catch(e) {}
}

function waitForSelection() {
  return new Promise(function(resolve) {
    var pageHtml = buildPickerPage();
    var srv = http.createServer(function(req, res) {
      if (req.method === 'GET' && req.url === '/') {
        var buf = Buffer.from(pageHtml);
        res.writeHead(200, {'Content-Type':'text/html','Content-Length':buf.length});
        res.end(buf);
      } else if (req.url.startsWith('/thumb/')) {
        var fname = decodeURIComponent(req.url.slice(7));
        var fp = path.join(THUMBS_DIR, fname);
        try {
          var data = fs.readFileSync(fp);
          res.writeHead(200, {'Content-Type':'image/jpeg','Content-Length':data.length});
          res.end(data);
        } catch(e) { res.writeHead(404); res.end(); }
      } else if (req.method === 'POST' && req.url === '/select') {
        var body = '';
        req.on('data', function(d){ body += d; });
        req.on('end', function() {
          res.writeHead(200); res.end();
          try { resolve(JSON.parse(body).preset); } catch(e) {}
          srv.close();
        });
      } else { res.writeHead(404); res.end(); }
    });
    srv.listen(PICKER_PORT, '127.0.0.1', function() {
      var url = 'http://127.0.0.1:' + PICKER_PORT + '/';
      console.log('\n  Opening browser: ' + url);
      console.log('  Click a preset thumbnail, then return here.\n');
      openBrowser(url);
    });
  });
}

async function selectAudio(rl, cfg) {
  clear();
  console.log('\n  Select audio file\n');
  if (cfg.audio) console.log('  Current: ' + cfg.audio + '\n');
  console.log('  Paste or drag-and-drop a WAV file path');
  console.log('  [Enter] Keep current  [b] Back\n');
  var input = stripQuotes(await ask(rl, '> '));
  if (input === 'b' || input === '') return;
  if (!fs.existsSync(input)) { console.log('\n  File not found.'); await ask(rl, '  Press Enter...'); return; }
  if (!input.toLowerCase().endsWith('.wav')) { console.log('\n  Must be a .wav file.'); await ask(rl, '  Press Enter...'); return; }
  cfg.audio = input;
}

async function selectOutput(rl, outputRef) {
  clear();
  console.log('\n  Output path\n');
  console.log('  Current: ' + outputRef.path);
  console.log('  [Enter] Keep current  [b] Back\n');
  var input = stripQuotes(await ask(rl, '> '));
  if (input === 'b' || input === '') return;
  outputRef.path = input.endsWith('.mp4') ? input : input + '.mp4';
  outputRef.custom = true;
}

async function doRender(rl, cfg, outputPath) {
  if (!cfg.preset) { console.log('\n  No preset selected.'); await ask(rl, '  Press Enter...'); return; }
  if (!cfg.audio)  { console.log('\n  No audio selected.'); await ask(rl, '  Press Enter...'); return; }
  clear();
  console.log('\n  Render\n');
  console.log('  Preset : ' + path.basename(cfg.preset, '.json'));
  console.log('  Audio  : ' + cfg.audio);
  console.log('  Output : ' + outputPath + '\n');
  var confirm = (await ask(rl, '  Start? [y/N] ')).trim().toLowerCase();
  if (confirm !== 'y') return;
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  saveConfig(cfg);
  console.log('\n  Rendering...\n');
  var child = spawn(process.execPath, ['--expose-gc',
    path.join(__dirname, 'render-preset.js'),
    '--preset=' + cfg.preset,
    '--audio=' + cfg.audio,
    '--output=' + outputPath
  ], { stdio: 'inherit' });
  await new Promise(function(res){ child.on('close', res); });
  await ask(rl, '\n  Done. Press Enter...');
}

async function doThumbnails(rl) {
  clear();
  console.log('\n  Generate thumbnails\n');
  console.log('  Renders preview frames for all presets (~16k, takes ~2-3 hours).\n');
  var confirm = (await ask(rl, '  Start? [y/N] ')).trim().toLowerCase();
  if (confirm !== 'y') return;
  console.log('\n  Running...\n');
  var child = spawn(process.execPath, [path.join(__dirname, 'update-thumbnails.js')], { stdio: 'inherit' });
  await new Promise(function(res){ child.on('close', res); });
  await ask(rl, '\n  Done. Press Enter...');
}

function printMenu(cfg, outputPath) {
  clear();
  console.log('\n  milkvid\n');
  console.log('  Preset : ' + (cfg.preset ? path.basename(cfg.preset, '.json') : '(none)'));
  console.log('  Audio  : ' + (cfg.audio || '(none)'));
  console.log('  Output : ' + (outputPath ? path.relative(__dirname, outputPath) : '(auto)') + '\n');
  console.log('  [1] Pick preset (visual browser)');
  console.log('  [2] Select audio');
  console.log('  [3] Change output path');
  console.log('  [4] Render');
  console.log('  [5] Generate thumbnails');
  console.log('  [q] Quit\n');
}

async function main() {
  var cfg = loadConfig();
  var outputRef = { path: cfg.preset ? autoOutputName(cfg.preset) : path.join(OUTPUT_DIR, 'output.mp4'), custom: false };
  var rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  while (true) {
    if (cfg.preset && !outputRef.custom) outputRef.path = autoOutputName(cfg.preset);
    printMenu(cfg, outputRef.path);
    var choice = (await ask(rl, '> ')).trim().toLowerCase();

    if (choice === 'q') break;
    else if (choice === '1') {
      var selected = await waitForSelection();
      if (selected) {
        cfg.preset = path.join(PRESETS_DIR, selected + '.json');
        console.log('\n  Selected: ' + selected);
        await ask(rl, '  Press Enter...');
      }
    }
    else if (choice === '2') await selectAudio(rl, cfg);
    else if (choice === '3') await selectOutput(rl, outputRef);
    else if (choice === '4') await doRender(rl, cfg, outputRef.path);
    else if (choice === '5') await doThumbnails(rl);
  }

  rl.close();
  clear();
  console.log('  Goodbye.\n');
}

main().catch(function(e){ console.error('Error:', e.message); process.exit(1); });
