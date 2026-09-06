const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const form = $('#form');
const status = $('#status');
const DRAFT = 'writing-desk-draft';
// Online build talks to the Worker; the local server answers the same paths.
const ONLINE = document.body.dataset.mode === 'online';

let type = 'word';
let existing = { word: [], blog: [] };

// Images just uploaded aren't on the deployed site yet; show the local copy
// in the preview until the rebuild catches up.
const localImages = new Map();

const api = (path, opts = {}) =>
  fetch(path, { credentials: 'same-origin', ...opts });

function loadExisting() {
  api('/api/existing').then(r => r.ok ? r.json() : null).then(e => {
    if (!e) return;
    existing = e;
    render();
    if (!$('[data-section="delete"]').hidden) renderDelList();
  }).catch(() => {});
}
loadExisting();

/* ---------- tiny markdown renderer (preview only) ---------- */
const esc = (s) => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

function inline(s) {
  return esc(s)
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, a, b) => `<a class="wikilink" href="#">${(b || a).trim()}</a>`)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, src) =>
      `<img src="${localImages.get(src) || src}" alt="${alt}" data-path="${src}" />`)
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
    const res = await api('/api/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...d, overwrite: !!overwrite }),
    });
    if (res.status === 401) { showLogin(); throw new Error('Session expired — sign in again.'); }
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


/* ---------- images: paste or drop into the body ---------- */
const bodyEl = form.elements.body;

function insertAtCursor(text) {
  const s = bodyEl.selectionStart ?? bodyEl.value.length;
  const e = bodyEl.selectionEnd ?? s;
  const before = bodyEl.value.slice(0, s);
  const after = bodyEl.value.slice(e);
  bodyEl.value = before + text + after;
  const pos = s + text.length;
  bodyEl.setSelectionRange(pos, pos);
  bodyEl.focus();
  render(); save();
}

async function uploadImage(file, suggestedName) {
  if (!file) return;
  const name = suggestedName || file.name?.replace(/\.[^.]+$/, '') || 'pasted-image';
  status.className = 'status';
  status.textContent = `Uploading ${file.type.split('/')[1] || 'image'}…`;

  const b64 = await new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result).split(',')[1]);
    fr.onerror = rej;
    fr.readAsDataURL(file);
  });

  const placeholder = `\n<!-- uploading ${name}… -->\n`;
  insertAtCursor(placeholder);

  try {
    const r = await api('/api/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: b64, mime: file.type, name }),
    });
    if (r.status === 401) { showLogin(); throw new Error('Session expired — sign in again.'); }
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Upload failed.');
    localImages.set(j.url, URL.createObjectURL(file));
    bodyEl.value = bodyEl.value.replace(placeholder, `\n![${name}](${j.url})\n`);
    status.className = 'status ok';
    status.innerHTML = `Added <code>${j.file}</code>`;
    setTimeout(() => { if (status.classList.contains('ok')) status.textContent = ''; }, 5000);
  } catch (err) {
    bodyEl.value = bodyEl.value.replace(placeholder, '');
    status.className = 'status err';
    status.textContent = err.message;
  }
  render(); save();
}

bodyEl.addEventListener('paste', (e) => {
  const items = [...(e.clipboardData?.items || [])];
  const img = items.find(i => i.type.startsWith('image/'));
  if (!img) return;                     // plain text pastes behave normally
  e.preventDefault();
  const f = img.getAsFile();
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  uploadImage(f, `pasted-${stamp}`);
});

['dragover', 'dragenter'].forEach(ev =>
  bodyEl.addEventListener(ev, (e) => { e.preventDefault(); bodyEl.style.borderColor = 'var(--ink)'; }));
['dragleave', 'drop'].forEach(ev =>
  bodyEl.addEventListener(ev, () => { bodyEl.style.borderColor = ''; }));

bodyEl.addEventListener('drop', (e) => {
  const f = [...(e.dataTransfer?.files || [])].find(x => x.type.startsWith('image/'));
  if (!f) return;
  e.preventDefault();
  uploadImage(f);
});

function showLogin() {
  const el = document.getElementById('login');
  if (el) el.hidden = false;
}
window.__loadExisting = loadExisting;

restore();
render();

/* ---------- section: write / delete ---------- */
function setSection(name) {
  $('#s-write').setAttribute('aria-pressed', String(name === 'write'));
  $('#s-delete').setAttribute('aria-pressed', String(name === 'delete'));
  $$('[data-section]').forEach(el => { el.hidden = el.dataset.section !== name; });
  if (name === 'delete') { loadExisting(); renderDelList(); }
}
$('#s-write').onclick = () => setSection('write');
$('#s-delete').onclick = () => setSection('delete');

/* ---------- delete ---------- */
let delType = 'word';
const selected = new Set();   // "type/slug", so a switch of tab keeps picks

const delKey = (t, s) => `${t}/${s}`;

function renderDelList() {
  const list = $('#d-list');
  const q = $('#d-filter').value.trim().toLowerCase();
  const slugs = (existing[delType] || []).filter(s => !q || s.includes(q)).sort();

  if (!slugs.length) {
    list.innerHTML = `<div class="del-empty">${q ? 'Nothing matches that filter.' : 'Nothing here yet.'}</div>`;
  } else {
    list.innerHTML = slugs.map(s => {
      const k = delKey(delType, s);
      const on = selected.has(k);
      const href = `/${delType === 'word' ? 'words' : 'blog'}/${s}/`;
      return `<label class="del-item${on ? ' on' : ''}" data-slug="${s}">
        <input type="checkbox" ${on ? 'checked' : ''} />
        <span>${esc(s)}.md</span>
        <a href="${href}" target="_blank" rel="noopener">view ↗</a>
      </label>`;
    }).join('');
    $$('#d-list .del-item').forEach(el => {
      el.querySelector('input').onchange = (e) => {
        const k = delKey(delType, el.dataset.slug);
        e.target.checked ? selected.add(k) : selected.delete(k);
        el.classList.toggle('on', e.target.checked);
        updateDelCount();
      };
      // the "view" link shouldn't toggle the row it sits in
      el.querySelector('a').onclick = (e) => e.stopPropagation();
    });
  }
  updateDelCount();
}

function updateDelCount() {
  const n = selected.size;
  $('#d-count').textContent = n ? `${n} selected` : 'Nothing selected';
  $('#d-go').disabled = !n;
}

function setDelType(t) {
  delType = t;
  $('#d-word').setAttribute('aria-pressed', String(t === 'word'));
  $('#d-blog').setAttribute('aria-pressed', String(t === 'blog'));
  renderDelList();
}
$('#d-word').onclick = () => setDelType('word');
$('#d-blog').onclick = () => setDelType('blog');
$('#d-filter').oninput = renderDelList;

$('#d-all').onclick = () => {
  const q = $('#d-filter').value.trim().toLowerCase();
  (existing[delType] || []).filter(s => !q || s.includes(q)).forEach(s => selected.add(delKey(delType, s)));
  renderDelList();
};
$('#d-none').onclick = () => { selected.clear(); renderDelList(); };

$('#d-go').onclick = async () => {
  const items = [...selected].map(k => {
    const i = k.indexOf('/');
    return { type: k.slice(0, i), slug: k.slice(i + 1) };
  });
  const names = items.map(i => `${i.slug}.md`).join('\n  ');
  if (!confirm(`Delete ${items.length} file${items.length > 1 ? 's' : ''}?\n\n  ${names}\n\nThis cannot be undone from here.`)) return;

  $('#d-go').disabled = true;
  const log = $('#d-log');
  log.textContent = 'Deleting…';
  try {
    const r = await api('/api/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items }),
    });
    if (r.status === 401) { showLogin(); throw new Error('Session expired — sign in again.'); }
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Delete failed.');

    const ok = (j.results || []).filter(x => x.ok);
    const bad = (j.results || []).filter(x => !x.ok);
    ok.forEach(x => {
      selected.delete(delKey(x.type, x.slug));
      existing[x.type] = (existing[x.type] || []).filter(s => s !== x.slug);
    });
    log.textContent =
      `Deleted ${ok.length} file${ok.length === 1 ? '' : 's'}.` +
      (bad.length ? `\nFailed: ${bad.map(x => `${x.slug} (${x.error})`).join(', ')}` : '') +
      `\nThe live site updates once the rebuild finishes.`;
    renderDelList();
  } catch (e) {
    log.textContent = e.message;
  } finally {
    updateDelCount();
  }
};

/* ---------- online: sign in / sign out ---------- */
if (ONLINE) {
  const overlay = document.getElementById('login');
  const lform = document.getElementById('login-form');
  const lerr = document.getElementById('login-err');
  const lbtn = document.getElementById('login-btn');

  // Already have a valid session cookie? Skip the overlay.
  api('/api/me')
    .then((r) => { if (r.ok) { overlay.hidden = true; loadExisting(); } })
    .catch(() => {});

  lform.addEventListener('submit', async (e) => {
    e.preventDefault();
    lerr.textContent = '';
    lbtn.disabled = true;
    lbtn.textContent = 'Checking…';
    try {
      const r = await api('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: document.getElementById('pw').value }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || 'Sign in failed.');
      overlay.hidden = true;
      document.getElementById('pw').value = '';
      loadExisting();
    } catch (err) {
      lerr.textContent = err.message;
    } finally {
      lbtn.disabled = false;
      lbtn.textContent = 'Sign in';
    }
  });

  document.getElementById('logout')?.addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST' }).catch(() => {});
    location.reload();
  });
}
