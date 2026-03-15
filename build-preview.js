'use strict';
const fs   = require('fs');
const path = require('path');

const THUMBS_DIR  = 'C:/dev/milkvid/thumbnails';
const PRESETS_DIR = 'C:/dev/milkvid/presets';
const OUT_FILE    = 'C:/dev/milkvid/preview.html';

function findThumbs(dir, base) {
  const results = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    const rel  = path.join(base, e.name);
    if (e.isDirectory()) results.push(...findThumbs(full, rel));
    else if (e.name.endsWith('.jpg')) {
      const sz = fs.statSync(full).size;
      if (sz > 1300) results.push({ rel: rel.replace(/\\/g, '/'), name: e.name.replace(/\.jpg$/, '') });
    }
  }
  return results;
}

const thumbs = findThumbs(THUMBS_DIR, '');
console.log(`Found ${thumbs.length} good thumbnails`);

// Group by first letter
const groups = {};
for (const t of thumbs) {
  const letter = t.name[0].toUpperCase();
  const key = /[A-Z]/.test(letter) ? letter : '#';
  if (!groups[key]) groups[key] = [];
  groups[key].push(t);
}
const sortedKeys = Object.keys(groups).sort((a, b) => a === '#' ? -1 : b === '#' ? 1 : a.localeCompare(b));

const totalPages = Math.ceil(thumbs.length / 200);

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>milkvid presets (${thumbs.length})</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: #0a0a0a; color: #ccc; font-family: system-ui, sans-serif; }
header { position: sticky; top: 0; z-index: 10; background: #111; padding: 10px 16px; display: flex; align-items: center; gap: 16px; border-bottom: 1px solid #222; }
header h1 { font-size: 14px; color: #888; white-space: nowrap; }
#search { flex: 1; background: #1a1a1a; border: 1px solid #333; border-radius: 4px; color: #eee; padding: 6px 10px; font-size: 13px; outline: none; }
#search:focus { border-color: #555; }
#count { font-size: 12px; color: #555; white-space: nowrap; }
.alpha-nav { background: #0f0f0f; padding: 6px 16px; display: flex; flex-wrap: wrap; gap: 4px; border-bottom: 1px solid #1a1a1a; }
.alpha-nav a { color: #555; text-decoration: none; font-size: 12px; padding: 2px 5px; border-radius: 3px; }
.alpha-nav a:hover { color: #aaa; background: #1a1a1a; }
.section { padding: 0 16px 24px; }
.section h2 { font-size: 11px; color: #444; letter-spacing: 2px; text-transform: uppercase; padding: 16px 0 8px; border-bottom: 1px solid #1a1a1a; margin-bottom: 12px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 6px; }
.card { position: relative; cursor: pointer; border-radius: 4px; overflow: hidden; background: #111; }
.card img { width: 100%; aspect-ratio: 4/3; object-fit: cover; display: block; }
.card .label { position: absolute; bottom: 0; left: 0; right: 0; background: linear-gradient(transparent, rgba(0,0,0,0.85)); padding: 16px 6px 5px; font-size: 10px; color: #bbb; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; opacity: 0; transition: opacity 0.15s; }
.card:hover .label { opacity: 1; }
.card:hover img { filter: brightness(1.1); }
.hidden { display: none !important; }
</style>
</head>
<body>
<header>
  <h1>milkvid presets</h1>
  <input id="search" type="search" placeholder="filter presets…" autocomplete="off">
  <span id="count">${thumbs.length.toLocaleString()} presets</span>
</header>
<nav class="alpha-nav">
${sortedKeys.map(k => `<a href="#group-${k}">${k}</a>`).join('\n')}
</nav>
${sortedKeys.map(k => `
<section class="section" id="group-${k}">
  <h2>${k}</h2>
  <div class="grid">
${groups[k].map(t => `    <div class="card" title="${t.name.replace(/"/g, '&quot;')}">
      <img loading="lazy" src="thumbnails/${t.rel}" alt="">
      <div class="label">${t.name.replace(/</g, '&lt;')}</div>
    </div>`).join('\n')}
  </div>
</section>`).join('')}
<script>
const search = document.getElementById('search');
const countEl = document.getElementById('count');
const cards = Array.from(document.querySelectorAll('.card'));
const total = cards.length;

search.addEventListener('input', () => {
  const q = search.value.trim().toLowerCase();
  let visible = 0;
  for (const c of cards) {
    const match = !q || c.title.toLowerCase().includes(q);
    c.classList.toggle('hidden', !match);
    if (match) visible++;
  }
  // Hide empty sections
  for (const sec of document.querySelectorAll('.section')) {
    const hasVisible = sec.querySelector('.card:not(.hidden)');
    sec.classList.toggle('hidden', !hasVisible);
  }
  countEl.textContent = q ? visible.toLocaleString() + ' / ' + total.toLocaleString() + ' presets' : total.toLocaleString() + ' presets';
});
</script>
</body>
</html>`;

fs.writeFileSync(OUT_FILE, html);
console.log(`Written: ${OUT_FILE} (${(html.length/1024).toFixed(0)} KB)`);
