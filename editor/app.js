const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const form = $('#form');
const status = $('#status');
const DRAFT = 'writing-desk-draft';

let type = 'word';
let existing = { word: [], blog: [] };

fetch('/api/existing').then(r => r.json()).then(e => { existing = e; render(); }).catch(() => {});

/* ---------- tiny markdown renderer (preview only) ---------- */
const esc = (s) => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

function inline(s) {
  return esc(s)
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, a, b) => `<a class="wikilink" href="#">${(b || a).trim()}</a>`)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
}

function md(src) {
  if (!src?.trim()) return '';
  const lines = src.replace(/\r/g, '').split('\n');
  let out = '', i = 0;

  while (i < lines.length) {
    const l = lines[i];

    if (!l.trim()) { i++; continue; }

    if (l.startsWith('```')) {                                  // code fence
      const lang = l.slice(3).trim();
      let code = ''; i++;
      while (i < lines.length && !lines[i].startsWith('```')) code += lines[i++] + '\n';
      i++;
      out += `<pre><code>${esc(code.replace(/\n$/, ''))}</code></pre>`;
      continue;
    }
    const h = l.match(/^(#{1,3})\s+(.*)$/);                     // heading
    if (h) { const n = h[1].length; out += `<h${n}>${inline(h[2])}</h${n}>`; i++; continue; }

    if (/^\s*([-*_])\1{2,}\s*$/.test(l)) { out += '<hr>'; i++; continue; }   // rule

    if (l.startsWith('|') && lines[i + 1]?.includes('-')) {      // table
      const rows = [];
      while (i < lines.length && lines[i].startsWith('|')) rows.push(lines[i++]);
      const cells = (r) => r.split('|').slice(1, -1).map(c => c.trim());
      const head = cells(rows[0]);
      const body = rows.slice(2).map(cells);
      out += `<table><thead><tr>${head.map(c => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>` +
        body.map(r => `<tr>${r.map(c => `<td>${inline(c)}</td>`).join('')}</tr>`).join('') + '</tbody></table>';
      continue;
    }
    if (/^\s*>/.test(l)) {                                       // blockquote
      let q = '';
      while (i < lines.length && /^\s*>/.test(lines[i])) q += lines[i++].replace(/^\s*>\s?/, '') + ' ';
      out += `<blockquote><p>${inline(q.trim())}</p></blockquote>`;
      continue;
    }
    if (/^\s*[-*+]\s+/.test(l)) {                                // ul
      let items = '';
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) items += `<li>${inline(lines[i++].replace(/^\s*[-*+]\s+/, ''))}</li>`;
      out += `<ul>${items}</ul>`;
      continue;
    }
    if (/^\s*\d+\.\s+/.test(l)) {                                // ol
      let items = '';
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) items += `<li>${inline(lines[i++].replace(/^\s*\d+\.\s+/, ''))}</li>`;
      out += `<ol>${items}</ol>`;
      continue;
    }
    let p = '';                                                  // paragraph
    while (i < lines.length && lines[i].trim() && !/^(#{1,3}\s|\s*[-*+]\s|\s*\d+\.\s|\s*>|\||```)/.test(lines[i])) p += lines[i++] + ' ';
    out += `<p>${inline(p.trim())}</p>`;
  }
  return out;
}

/* ---------- form state ---------- */
const data = () => {
  const f = Object.fromEntries(new FormData(form));
  f.type = type;
  f.examples = $$('#examples input').map(i => i.value).filter(v => v.trim());
  return f;
};

function setType(t) {
  type = t;
  $('#t-word').setAttribute('aria-pressed', String(t === 'word'));
  $('#t-blog').setAttribute('aria-pressed', String(t === 'blog'));
  $$('[data-for]').forEach(el => { el.hidden = el.dataset.for !== t; });
  render();
}
$('#t-word').onclick = () => { setType('word'); save(); };
$('#t-blog').onclick = () => { setType('blog'); save(); };

function addExample(v = '') {
  const row = document.createElement('div');
  row.className = 'ex-row';
  row.innerHTML = `<input placeholder="A sentence using the word." /><button type="button" title="Remove">×</button>`;
  row.querySelector('input').value = v;
  row.querySelector('input').oninput = () => { render(); save(); };
  row.querySelector('button').onclick = () => { row.remove(); render(); save(); };
  $('#examples').append(row);
}
$('#add-ex').onclick = () => { addExample(); $('#examples .ex-row:last-child input').focus(); };

const slugify = (s) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const fmtDate = (s) => {
  if (!s) return '';
  const d = new Date(s + 'T12:00:00');
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
};

/* ---------- preview ---------- */
function render() {
  const d = data();
  const tags = (d.tags || '').split(',').map(t => t.trim()).filter(Boolean);
  const tagHtml = tags.length ? `<hr><div class="tags">${tags.map(t => `<a class="tag" href="#">#${esc(t)}</a>`).join('')}</div>` : '';
  let h = '';

  if (type === 'word') {
    if (!d.word?.trim() && !d.meaning?.trim()) {
      $('#preview').innerHTML = `<p style="color:var(--ink-3)">Start typing on the left.</p>`;
      return dupeCheck(d);
    }
    h += `<div class="word-head"><span class="badge">word</span>
      <div class="word-title">${esc(d.word || 'untitled')}</div>
      <div class="entry-meta">
        ${d.pronunciation?.trim() ? `<span class="pron">${esc(d.pronunciation)}</span>` : ''}
        ${d.partOfSpeech?.trim() ? `<span class="pos">${esc(d.partOfSpeech)}</span>` : ''}
      </div>
      ${d.meaning?.trim() ? `<p class="meaning">${esc(d.meaning)}</p>` : ''}</div>`;
    if (d.examples.length) {
      h += `<h2>In a sentence</h2><ul class="examples">${d.examples.map(e => `<li>${esc(e)}</li>`).join('')}</ul>`;
    }
    if (d.etymology?.trim()) h += `<h2>Where it comes from</h2><div class="etym">${inline(d.etymology)}</div>`;
    h += `<div class="prose">${md(d.body)}</div>${tagHtml}`;
  } else {
    if (!d.title?.trim() && !d.body?.trim()) {
      $('#preview').innerHTML = `<p style="color:var(--ink-3)">Start typing on the left.</p>`;
      return dupeCheck(d);
    }
    h += `<div class="word-head"><span class="badge">blog</span>
      <h1 style="margin:.3rem 0 .2rem">${esc(d.title || 'Untitled')}</h1>
      <span class="date">${fmtDate(d.added)}</span>
      ${d.blurb?.trim() ? `<p class="meaning">${esc(d.blurb)}</p>` : ''}</div>
      <div class="prose">${md(d.body)}</div>${tagHtml}`;
  }
  $('#preview').innerHTML = h;
  dupeCheck(d);
}

function dupeCheck(d) {
  const name = type === 'word' ? d.word : d.title;
  const slug = slugify(name || '');
  const box = $('#dupe');
  if (slug && existing[type]?.includes(slug)) {
    box.innerHTML = `<div class="warn"><strong>${slug}.md</strong> already exists. Saving will overwrite it.</div>`;
  } else {
    box.innerHTML = slug ? `<div class="hintline" style="margin-top:.8rem">Will save as <code>${slug}.md</code></div>` : '';
  }
}

/* ---------- draft persistence ---------- */
function save() {
  try { localStorage.setItem(DRAFT, JSON.stringify({ ...data(), type })); } catch {}
}
function restore() {
  let d; try { d = JSON.parse(localStorage.getItem(DRAFT) || 'null'); } catch {}
  if (!d) { $('[name=added]').value = new Date().toISOString().slice(0, 10); addExample(); return; }
  setType(d.type || 'word');
  for (const [k, v] of Object.entries(d)) {
    const el = form.elements[k];
    if (el && typeof v === 'string') el.value = v;
  }
  if (!$('[name=added]').value) $('[name=added]').value = new Date().toISOString().slice(0, 10);
  (d.examples?.length ? d.examples : ['']).forEach(addExample);
}

form.addEventListener('input', () => { render(); save(); });

$('#clear').onclick = () => {
  if (!confirm('Clear the form? Your saved files are untouched.')) return;
  form.reset();
  $('#examples').innerHTML = '';
  addExample();
  $('[name=added]').value = new Date().toISOString().slice(0, 10);
  localStorage.removeItem(DRAFT);
  render();
};

/* ---------- save to disk ---------- */
async function doSave() {
  const d = data();
  const name = type === 'word' ? d.word : d.title;
  const slug = slugify(name || '');
  const overwrite = slug && existing[type]?.includes(slug);
  if (overwrite && !confirm(`Overwrite ${slug}.md?`)) return;

  $('#save').disabled = true;
  status.className = 'status';
  status.textContent = 'Saving…';
  try {
    const res = await fetch('/api/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...d, overwrite: !!overwrite }),
    });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error || 'Save failed.');
    status.className = 'status ok';
    status.innerHTML = `Saved <code>${j.file}</code>`;
    if (!existing[type].includes(j.slug)) existing[type].push(j.slug);
    localStorage.removeItem(DRAFT);
    form.reset();
    $('#examples').innerHTML = '';
    addExample();
    $('[name=added]').value = new Date().toISOString().slice(0, 10);
    render();
    setTimeout(() => { if (status.classList.contains('ok')) status.textContent = ''; }, 6000);
  } catch (e) {
    status.className = 'status err';
    status.textContent = e.message;
  } finally {
    $('#save').disabled = false;
  }
}
$('#save').onclick = doSave;

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); doSave(); }
});

restore();
render();
