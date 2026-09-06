#!/usr/bin/env node
// Local writing desk. Serves a split-screen markdown editor and writes .md files
// straight into src/content. No dependencies, no auth — localhost only.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4444);
const DIRS = { word: 'src/content/words', blog: 'src/content/blog' };

const slugify = (s) =>
  s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// YAML strings get quoted so a stray colon or quote can't break the build.
const yamlStr = (s) => JSON.stringify(String(s ?? ''));
const yamlList = (a) => `[${(a || []).map((x) => x.trim()).filter(Boolean).join(', ')}]`;

function buildMarkdown(d) {
  const today = new Date().toISOString().slice(0, 10);
  const date = d.added || today;
  const tags = (d.tags || '').split(',').map((t) => t.trim()).filter(Boolean);

  if (d.type === 'word') {
    const examples = (d.examples || []).map((e) => e.trim()).filter(Boolean);
    let fm = `---\nword: ${yamlStr(d.word)}\n`;
    if (d.pronunciation?.trim()) fm += `pronunciation: ${yamlStr(d.pronunciation)}\n`;
    if (d.partOfSpeech?.trim()) fm += `partOfSpeech: ${yamlStr(d.partOfSpeech)}\n`;
    fm += `meaning: ${yamlStr(d.meaning)}\n`;
    if (examples.length) {
      fm += `examples:\n${examples.map((e) => `  - ${yamlStr(e)}`).join('\n')}\n`;
    } else {
      fm += `examples: []\n`;
    }
    if (d.etymology?.trim()) fm += `etymology: ${yamlStr(d.etymology)}\n`;
    fm += `tags: ${yamlList(tags)}\nadded: ${date}\n---\n`;
    return d.body?.trim() ? `${fm}\n${d.body.trim()}\n` : fm;
  }

  const fm =
    `---\ntitle: ${yamlStr(d.title)}\nblurb: ${yamlStr(d.blurb)}\n` +
    `tags: ${yamlList(tags)}\nadded: ${date}\n---\n`;
  return d.body?.trim() ? `${fm}\n${d.body.trim()}\n` : fm;
}

function validate(d) {
  if (!['word', 'blog'].includes(d.type)) return 'Unknown type.';
  if (d.type === 'word') {
    if (!d.word?.trim()) return 'Word is required.';
    if (!d.meaning?.trim()) return 'Meaning is required.';
  } else {
    if (!d.title?.trim()) return 'Title is required.';
    if (!d.blurb?.trim()) return 'Blurb is required.';
  }
  return null;
}

const body = (req, cap = 1e6) =>
  new Promise((res, rej) => {
    let s = '';
    req.on('data', (c) => {
      s += c;
      if (s.length > cap) req.destroy();
    });
    req.on('end', () => res(s));
    req.on('error', rej);
  });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const send = (code, type, data) =>
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }).end(data);
  const json = (code, o) => send(code, 'application/json', JSON.stringify(o));

  if (url.pathname === '/' || url.pathname === '/index.html') {
    return send(200, 'text/html; charset=utf-8', fs.readFileSync(path.join(ROOT, 'editor/index.html')));
  }
  if (url.pathname === '/editor.js' || url.pathname === '/app.js') {
    return send(200, 'text/javascript; charset=utf-8', fs.readFileSync(path.join(ROOT, 'public/editor.js')));
  }
  if (url.pathname.startsWith('/images/')) {
    const name = path.basename(decodeURIComponent(url.pathname));
    const f = path.join(ROOT, 'public/images', name);
    if (!fs.existsSync(f)) return send(404, 'text/plain', 'Not found');
    const ext = path.extname(f).slice(1).toLowerCase();
    const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif' }[ext] || 'application/octet-stream';
    return res.writeHead(200, { 'Content-Type': mime }).end(fs.readFileSync(f));
  }
  if (url.pathname === '/site.css') {
    return send(200, 'text/css; charset=utf-8', fs.readFileSync(path.join(ROOT, 'src/styles/global.css')));
  }

  // Existing slugs, so the editor can warn before overwriting.
  if (url.pathname === '/api/existing') {
    const out = {};
    for (const [t, dir] of Object.entries(DIRS)) {
      out[t] = fs.existsSync(path.join(ROOT, dir))
        ? fs.readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3))
        : [];
    }
    return json(200, out);
  }

  // Load one entry back into the editor.
  if (url.pathname === '/api/load') {
    const type = url.searchParams.get('type');
    const slug = slugify(url.searchParams.get('slug') || '');
    if (!DIRS[type] || !slug) return json(400, { error: 'Bad request.' });
    const file = path.join(ROOT, DIRS[type], `${slug}.md`);
    if (!fs.existsSync(file)) return json(404, { error: 'Not found.' });
    return json(200, { raw: fs.readFileSync(file, 'utf8') });
  }


  // Clipboard/dropped images land in public/images and are referenced as /images/<name>.
  if (url.pathname === '/api/upload' && req.method === 'POST') {
    let d;
    try { d = JSON.parse(await body(req, 12e6)); } catch { return json(400, { error: 'Image too large or malformed.' }); }

    const okTypes = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif' };
    const ext = okTypes[d.mime];
    if (!ext) return json(400, { error: `Unsupported image type${d.mime ? ` (${d.mime})` : ''}.` });

    const buf = Buffer.from(String(d.data || ''), 'base64');
    if (!buf.length) return json(400, { error: 'Empty image.' });
    if (buf.length > 8 * 1024 * 1024) return json(413, { error: 'Image is larger than 8 MB.' });

    const base = slugify(d.name || '') || 'image';
    const dir = path.join(ROOT, 'public/images');
    fs.mkdirSync(dir, { recursive: true });

    let file = `${base}.${ext}`, n = 2;
    while (fs.existsSync(path.join(dir, file))) file = `${base}-${n++}.${ext}`;

    fs.writeFileSync(path.join(dir, file), buf);
    console.log(`  image  public/images/${file}  (${(buf.length / 1024).toFixed(0)} KB)`);
    return json(200, { ok: true, url: `/images/${file}`, file: `public/images/${file}` });
  }

  if (url.pathname === '/api/save' && req.method === 'POST') {
    let d;
    try { d = JSON.parse(await body(req)); } catch { return json(400, { error: 'Bad JSON.' }); }

    const err = validate(d);
    if (err) return json(400, { error: err });

    const slug = slugify(d.type === 'word' ? d.word : d.title);
    if (!slug) return json(400, { error: 'Could not make a filename from that title.' });

    const dir = path.join(ROOT, DIRS[d.type]);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${slug}.md`);

    // Never silently clobber an existing entry.
    if (fs.existsSync(file) && !d.overwrite) {
      return json(409, { error: `“${slug}” already exists.`, slug, exists: true });
    }

    fs.writeFileSync(file, buildMarkdown(d));
    const rel = path.relative(ROOT, file);
    console.log(`  saved  ${rel}`);
    return json(200, { ok: true, slug, file: rel, url: `/${d.type === 'word' ? 'words' : 'blog'}/${slug}/` });
  }

  send(404, 'text/plain', 'Not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  Writing desk → http://localhost:${PORT}`);
  console.log(`  Files land in src/content/. Run "npm run dev" too for the live site.\n`);
});
