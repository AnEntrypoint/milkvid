'use strict';
var fs = require('fs');
var http = require('http');
var path = require('path');
var { spawn, execSync } = require('child_process');
var os = require('os');

var PORT       = 19877;
var PRESETS    = path.join(__dirname, 'presets');
var THUMBS     = path.join(__dirname, 'thumbnails');
var OUTPUT     = path.join(__dirname, 'output');
var INDEX_HTML = path.join(__dirname, 'index.html');

var job = { running: false, frame: 0, total: 0, fps: 0, eta: 0, error: null, done: false, outFile: null };
var sseClients = [];

function broadcast(data) {
  var msg = 'data: ' + JSON.stringify(data) + '\n\n';
  sseClients = sseClients.filter(function(res) {
    try { res.write(msg); return true; } catch(e) { return false; }
  });
}

function parseProgress(line) {
  var m = line.match(/Frame (\d+)\/(\d+) \(([\d.]+)%\) \| ([\d.]+) fps \| ETA ([\d.]+)hr/);
  if (!m) return null;
  return { frame: +m[1], total: +m[2], pct: +m[3], fps: +m[4], eta: +m[5] };
}

function serve(req, res) {
  var u = req.url.split('?')[0];

  if (req.method === 'GET' && u === '/') {
    var html = fs.readFileSync(INDEX_HTML);
    res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Length': html.length });
    return res.end(html);
  }

  if (req.method === 'GET' && u === '/api/presets') {
    var names = fs.readdirSync(PRESETS)
      .filter(function(f) { return f.endsWith('.json'); })
      .map(function(f) { return f.slice(0, -5); });
    var body = JSON.stringify(names);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    return res.end(body);
  }

  if (req.method === 'GET' && u.startsWith('/thumb/')) {
    var fname = decodeURIComponent(u.slice(7));
    var fp = path.join(THUMBS, fname);
    try {
      var img = fs.readFileSync(fp);
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': img.length });
      return res.end(img);
    } catch(e) { res.writeHead(404); return res.end(); }
  }

  if (req.method === 'POST' && u === '/api/render') {
    if (job.running) { res.writeHead(409); return res.end(JSON.stringify({ error: 'Render in progress' })); }
    var body = '';
    req.on('data', function(d) { body += d; });
    req.on('end', function() {
      var data;
      try { data = JSON.parse(body); } catch(e) { res.writeHead(400); return res.end(JSON.stringify({ error: 'Invalid JSON' })); }
      if (!data.preset || !data.audioBase64) { res.writeHead(400); return res.end(JSON.stringify({ error: 'Missing preset or audio' })); }

      var outName = (data.output || data.preset).replace(/[^a-zA-Z0-9-]/g, '-').replace(/-+/g, '-').toLowerCase().slice(0, 60);
      var outFile = path.join(OUTPUT, outName + '.mp4');
      var tmpAudio = path.join(os.tmpdir(), 'milkvid-audio-' + Date.now() + '.wav');
      fs.mkdirSync(OUTPUT, { recursive: true });
      fs.writeFileSync(tmpAudio, Buffer.from(data.audioBase64, 'base64'));

      job = { running: true, frame: 0, total: 0, fps: 0, eta: 0, error: null, done: false, outFile: outFile };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));

      var presetPath = path.join(PRESETS, data.preset + '.json');
      var child = spawn(process.execPath, ['--expose-gc', path.join(__dirname, 'render-preset.js'),
        '--preset=' + presetPath, '--audio=' + tmpAudio, '--output=' + outFile
      ], { stdio: ['ignore', 'pipe', 'pipe'] });

      child.stdout.on('data', function(d) {
        d.toString().split('\n').forEach(function(line) {
          var p = parseProgress(line);
          if (p) { job.frame = p.frame; job.total = p.total; job.fps = p.fps; job.eta = p.eta; broadcast({ type: 'progress', ...p }); }
        });
      });
      child.stderr.on('data', function(d) { process.stderr.write(d); });
      child.on('close', function(code) {
        try { fs.unlinkSync(tmpAudio); } catch(e) {}
        if (code === 0) { job.running = false; job.done = true; broadcast({ type: 'done', file: path.basename(outFile) }); }
        else { job.running = false; job.error = 'Render failed (exit ' + code + ')'; broadcast({ type: 'error', error: job.error }); }
      });
    });
    return;
  }

  if (req.method === 'GET' && u === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    res.write('data: ' + JSON.stringify({ type: 'connected', job: job }) + '\n\n');
    sseClients.push(res);
    req.on('close', function() { sseClients = sseClients.filter(function(c) { return c !== res; }); });
    return;
  }

  if (req.method === 'GET' && u.startsWith('/api/download/')) {
    var name = path.basename(decodeURIComponent(u.slice(14)));
    var fp2 = path.join(OUTPUT, name);
    try {
      var stat = fs.statSync(fp2);
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': stat.size, 'Content-Disposition': 'attachment; filename="' + name + '"' });
      fs.createReadStream(fp2).pipe(res);
    } catch(e) { res.writeHead(404); res.end(); }
    return;
  }

  res.writeHead(404); res.end();
}

var srv = http.createServer(serve);
srv.listen(PORT, '127.0.0.1', function() {
  var url = 'http://127.0.0.1:' + PORT + '/';
  console.log('milkvid server running at ' + url);
  try { execSync('start "" "' + url + '"', { shell: true }); } catch(e) {}
});
