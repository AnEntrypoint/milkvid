'use strict';
var fs = require('fs');
var path = require('path');
var readline = require('readline');
var { spawn } = require('child_process');

var CONFIG_FILE = path.join(__dirname, '.milkvid-config.json');
var PRESETS_DIR = path.join(__dirname, 'presets');
var OUTPUT_DIR = path.join(__dirname, 'output');

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (e) { return {}; }
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

function allPresets() {
  return fs.readdirSync(PRESETS_DIR).filter(function(f) { return f.endsWith('.json'); });
}

function fuzzyFilter(list, term) {
  if (!term) return list;
  var lower = term.toLowerCase();
  var chars = lower.split('');
  return list.filter(function(name) {
    var n = name.toLowerCase();
    var idx = 0;
    for (var i = 0; i < chars.length; i++) {
      var pos = n.indexOf(chars[i], idx);
      if (pos === -1) return false;
      idx = pos + 1;
    }
    return true;
  });
}

function autoOutputName(presetFile) {
  var base = path.basename(presetFile, '.json')
    .replace(/[^a-zA-Z0-9-]+/g, '-').replace(/-+/g, '-').toLowerCase().slice(0, 60);
  var ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return path.join(OUTPUT_DIR, base + '-' + ts + '.mp4');
}

function ask(rl, prompt) {
  return new Promise(function(res) { rl.question(prompt, res); });
}

function clearScreen() { process.stdout.write('\x1b[2J\x1b[H'); }

function printMenu(cfg, outputPath) {
  clearScreen();
  console.log('\n  milkvid\n');
  console.log('  Preset: ' + (cfg.preset ? path.basename(cfg.preset, '.json') : '(none)'));
  console.log('  Audio:  ' + (cfg.audio || '(none)'));
  console.log('  Output: ' + path.relative(__dirname, outputPath) + '\n');
  console.log('  [1] Change preset');
  console.log('  [2] Change audio');
  console.log('  [3] Change output path');
  console.log('  [4] Render');
  console.log('  [q] Quit\n');
}

async function selectPreset(rl, cfg) {
  var presets = allPresets();
  var page = 0;
  var PAGE = 20;
  var filter = '';

  while (true) {
    var filtered = fuzzyFilter(presets, filter);
    var totalPages = Math.max(1, Math.ceil(filtered.length / PAGE));
    if (page >= totalPages) page = 0;
    var slice = filtered.slice(page * PAGE, page * PAGE + PAGE);

    clearScreen();
    console.log('\n  Select preset (total: ' + filtered.length + ')');
    console.log('  Filter: ' + (filter || '(none)') + '   Page ' + (page+1) + '/' + totalPages + '\n');
    slice.forEach(function(f, i) {
      var mark = cfg.preset === path.join(PRESETS_DIR, f) ? ' *' : '';
      console.log('  [' + (i+1) + '] ' + path.basename(f, '.json') + mark);
    });
    console.log('\n  [n] Next page  [p] Prev page  [c] Clear filter  [b] Back');
    console.log('  Type a number to select, or type text to filter\n');

    var input = (await ask(rl, '> ')).trim();
    if (input === 'b') return;
    if (input === 'n') { page = (page + 1) % totalPages; continue; }
    if (input === 'p') { page = (page - 1 + totalPages) % totalPages; continue; }
    if (input === 'c') { filter = ''; page = 0; continue; }
    var num = parseInt(input, 10);
    if (!isNaN(num) && num >= 1 && num <= slice.length) {
      cfg.preset = path.join(PRESETS_DIR, slice[num - 1]);
      return;
    }
    filter = input;
    page = 0;
  }
}

async function selectAudio(rl, cfg) {
  clearScreen();
  console.log('\n  Select audio file\n');
  if (cfg.audio) console.log('  Last used: ' + cfg.audio + '\n');
  console.log('  Paste or type a WAV file path (drag-and-drop works)');
  console.log('  [Enter] Keep current  [b] Back\n');

  var input = (await ask(rl, '> ')).trim().replace(/^["']|["']$/g, '');
  if (input === 'b' || input === '') return;

  if (!fs.existsSync(input)) { console.log('  File not found: ' + input); await ask(rl, '  Press Enter...'); return; }
  if (!input.toLowerCase().endsWith('.wav')) { console.log('  Not a WAV file.'); await ask(rl, '  Press Enter...'); return; }
  cfg.audio = input;
}

async function selectOutput(rl, outputRef) {
  clearScreen();
  console.log('\n  Output path\n');
  console.log('  Current: ' + outputRef.path);
  console.log('  [Enter] Keep current  [b] Back\n');

  var input = (await ask(rl, '> ')).trim().replace(/^["']|["']$/g, '');
  if (input === 'b' || input === '') return;
  outputRef.path = input;
}

async function doRender(rl, cfg, outputPath) {
  if (!cfg.preset) { console.log('  No preset selected.'); await ask(rl, '  Press Enter...'); return; }
  if (!cfg.audio) { console.log('  No audio selected.'); await ask(rl, '  Press Enter...'); return; }

  clearScreen();
  console.log('\n  Render summary\n');
  console.log('  Preset: ' + path.basename(cfg.preset, '.json'));
  console.log('  Audio:  ' + cfg.audio);
  console.log('  Output: ' + outputPath + '\n');

  var confirm = (await ask(rl, '  Start render? [y/N] ')).trim().toLowerCase();
  if (confirm !== 'y') return;

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  saveConfig(cfg);

  console.log('\n  Rendering...\n');
  var child = spawn(process.execPath, [
    path.join(__dirname, 'render-preset.js'),
    '--preset=' + cfg.preset,
    '--audio=' + cfg.audio,
    '--output=' + outputPath
  ], { stdio: 'inherit' });

  await new Promise(function(res) { child.on('close', res); });
  await ask(rl, '\n  Press Enter to continue...');
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log('milkvid - interactive video renderer\nUsage: node milkvid.js\n');
    console.log('Flags:\n  --help    Show this help\n');
    process.exit(0);
  }

  var cfg = loadConfig();
  var outputRef = { path: cfg.preset ? autoOutputName(cfg.preset) : autoOutputName('preset') };

  var rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  while (true) {
    if (cfg.preset && outputRef.path.startsWith(OUTPUT_DIR) && !outputRef._custom) {
      outputRef.path = autoOutputName(cfg.preset);
    }
    printMenu(cfg, outputRef.path);
    var choice = (await ask(rl, '> ')).trim().toLowerCase();

    if (choice === 'q') break;
    if (choice === '1') { await selectPreset(rl, cfg); outputRef._custom = false; }
    else if (choice === '2') { await selectAudio(rl, cfg); }
    else if (choice === '3') { await selectOutput(rl, outputRef); outputRef._custom = true; }
    else if (choice === '4') { await doRender(rl, cfg, outputRef.path); }
  }

  rl.close();
  clearScreen();
  console.log('  Goodbye.\n');
}

main().catch(function(e) { console.error('Error:', e.message); process.exit(1); });
