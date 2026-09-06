/**
 * Serves the static site, plus a private /admin desk that commits
 * Markdown straight to GitHub (write) and removes it again (delete).
 *
 * Secrets (set in Cloudflare, never in the repo):
 *   ADMIN_PASSWORD_HASH  sha256 hex of the passphrase
 *   SESSION_SECRET       random string used to sign session cookies
 *   GITHUB_TOKEN         fine-grained PAT, Contents: read+write on this repo
 *   GITHUB_REPO          e.g. "Avenge-PRC777/prraths-notes"
 */

const COOKIE = 'wd_session';
const DIRS = { word: 'src/content/words', blog: 'src/content/blog' };
const SESSION_DAYS = 30;
const enc = new TextEncoder();

const sha256hex = async (s) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)))]
    .map((b) => b.toString(16).padStart(2, '0')).join('');

async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Constant-time compare so a wrong guess leaks no timing signal.
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

const makeSession = async (env) => {
  const exp = Date.now() + SESSION_DAYS * 864e5;
  return `${exp}.${await hmac(env.SESSION_SECRET, String(exp))}`;
};

async function validSession(req, env) {
  const raw = (req.headers.get('Cookie') || '')
    .split(';').map((c) => c.trim()).find((c) => c.startsWith(`${COOKIE}=`));
  if (!raw) return false;
  const [exp, sig] = decodeURIComponent(raw.slice(COOKIE.length + 1)).split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return safeEqual(sig, await hmac(env.SESSION_SECRET, exp));
}

const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });

/* ---------------- GitHub ---------------- */

const REPO = (env) => env.GITHUB_REPO || 'Avenge-PRC777/prraths-notes';
const branch = (env) => env.GITHUB_BRANCH || 'main';

const gh = (env, path, init = {}) =>
  fetch(`https://api.github.com/repos/${REPO(env)}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'prraths-notes-writer',
      ...(init.headers || {}),
    },
  });

// Images only: the tree API takes UTF-8 text, so binary still goes through
// the contents API (one image = one commit, and uploads are one at a time).
async function ghPut(env, filePath, contentB64, message) {
  // A file that already exists needs its blob sha to update rather than fail.
  let sha;
  const head = await gh(env, `/contents/${encodeURI(filePath)}`);
  if (head.ok) sha = (await head.json()).sha;

  const res = await gh(env, `/contents/${encodeURI(filePath)}`, {
    method: 'PUT',
    body: JSON.stringify({ message, content: contentB64, ...(sha ? { sha } : {}) }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`GitHub ${res.status}: ${t.slice(0, 200)}`);
  }
  return { updated: !!sha };
}

// One commit for many files. The contents API commits per call, which would
// mean N pushes and N Cloudflare builds; the Git Data API lets us stage every
// change into a single tree and move the branch once.
async function ghCommit(env, changes, message) {
  const ref = await gh(env, `/git/ref/heads/${branch(env)}`);
  if (!ref.ok) throw new Error(`GitHub ${ref.status}: could not read branch.`);
  const headSha = (await ref.json()).object.sha;

  const commit = await gh(env, `/git/commits/${headSha}`);
  if (!commit.ok) throw new Error(`GitHub ${commit.status}: could not read head commit.`);
  const baseTree = (await commit.json()).tree.sha;

  // sha:null deletes; content writes. Blobs are created inline as UTF-8 text.
  const tree = changes.map((c) =>
    c.delete
      ? { path: c.path, mode: '100644', type: 'blob', sha: null }
      : { path: c.path, mode: '100644', type: 'blob', content: c.content });

  const treeRes = await gh(env, '/git/trees', {
    method: 'POST',
    body: JSON.stringify({ base_tree: baseTree, tree }),
  });
  if (!treeRes.ok) throw new Error(`GitHub ${treeRes.status}: ${(await treeRes.text()).slice(0, 200)}`);
  const treeSha = (await treeRes.json()).sha;

  const commitRes = await gh(env, '/git/commits', {
    method: 'POST',
    body: JSON.stringify({ message, tree: treeSha, parents: [headSha] }),
  });
  if (!commitRes.ok) throw new Error(`GitHub ${commitRes.status}: ${(await commitRes.text()).slice(0, 200)}`);
  const newSha = (await commitRes.json()).sha;

  const upd = await gh(env, `/git/refs/heads/${branch(env)}`, {
    method: 'PATCH',
    body: JSON.stringify({ sha: newSha }),
  });
  if (!upd.ok) throw new Error(`GitHub ${upd.status}: ${(await upd.text()).slice(0, 200)}`);
  return { sha: newSha };
}

// Which of these paths exist, so we can report misses and skip a commit that
// would change nothing. One recursive tree read rather than a HEAD per path:
// Workers allow 50 subrequests per request on the free plan, and checking a
// 50-file batch one at a time would blow through that.
async function ghExistingPaths(env, paths) {
  const want = new Set(paths);
  const ref = await gh(env, `/git/ref/heads/${branch(env)}`);
  if (!ref.ok) throw new Error(`GitHub ${ref.status}: could not read branch.`);
  const tree = await gh(env, `/git/trees/${(await ref.json()).object.sha}?recursive=1`);
  if (!tree.ok) throw new Error(`GitHub ${tree.status}: could not read tree.`);
  const t = await tree.json();
  // On a very large repo GitHub truncates the listing. Reporting every file as
  // "already gone" would be worse than a slower per-path check, so fall back.
  if (t.truncated) {
    const found = new Set();
    await Promise.all(paths.map(async (path) => {
      const r = await gh(env, `/contents/${encodeURI(path)}`);
      if (r.ok) found.add(path);
    }));
    return found;
  }
  return new Set(t.tree.filter((e) => e.type === 'blob' && want.has(e.path)).map((e) => e.path));
}

/* ---------------- content helpers ---------------- */

const slugify = (s) => String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const yamlStr = (s) => JSON.stringify(String(s ?? ''));
const yamlList = (a) => `[${(a || []).map((x) => x.trim()).filter(Boolean).join(', ')}]`;

function buildMarkdown(d) {
  const date = d.added || new Date().toISOString().slice(0, 10);
  const tags = (d.tags || '').split(',').map((t) => t.trim()).filter(Boolean);

  if (d.type === 'word') {
    const examples = (d.examples || []).map((e) => e.trim()).filter(Boolean);
    let fm = `---\nword: ${yamlStr(d.word)}\n`;
    if (d.pronunciation?.trim()) fm += `pronunciation: ${yamlStr(d.pronunciation)}\n`;
    if (d.partOfSpeech?.trim()) fm += `partOfSpeech: ${yamlStr(d.partOfSpeech)}\n`;
    fm += `meaning: ${yamlStr(d.meaning)}\n`;
    fm += examples.length
      ? `examples:\n${examples.map((e) => `  - ${yamlStr(e)}`).join('\n')}\n`
      : `examples: []\n`;
    if (d.etymology?.trim()) fm += `etymology: ${yamlStr(d.etymology)}\n`;
    fm += `tags: ${yamlList(tags)}\nadded: ${date}\n---\n`;
    return d.body?.trim() ? `${fm}\n${d.body.trim()}\n` : fm;
  }
  const fm = `---\ntitle: ${yamlStr(d.title)}\nblurb: ${yamlStr(d.blurb)}\ntags: ${yamlList(tags)}\nadded: ${date}\n---\n`;
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

/* ---------------- handler ---------------- */

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;

    if (!p.startsWith('/api/')) return env.ASSETS.fetch(req);

    const missing = ['ADMIN_PASSWORD_HASH', 'SESSION_SECRET', 'GITHUB_TOKEN'].filter((k) => !env[k]);
    if (missing.length) {
      return json({ error: `Server is missing: ${missing.join(', ')}.` }, 503);
    }

    /* --- login --- */
    if (p === '/api/login' && req.method === 'POST') {
      let body;
      try { body = await req.json(); } catch { return json({ error: 'Bad request.' }, 400); }
      const given = await sha256hex(String(body.password || ''));
      if (!safeEqual(given, env.ADMIN_PASSWORD_HASH.toLowerCase())) {
        await new Promise((r) => setTimeout(r, 600));   // slow down guessing
        return json({ error: 'Wrong passphrase.' }, 401);
      }
      const token = await makeSession(env);
      return json({ ok: true }, 200, {
        'Set-Cookie': `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`,
      });
    }

    if (p === '/api/logout' && req.method === 'POST') {
      return json({ ok: true }, 200, { 'Set-Cookie': `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` });
    }

    /* --- everything below needs a session --- */
    if (!(await validSession(req, env))) return json({ error: 'Not signed in.' }, 401);

    if (p === '/api/me') return json({ ok: true });

    if (p === '/api/existing') {
      const out = { word: [], blog: [] };
      for (const [t, dir] of Object.entries(DIRS)) {
        const r = await gh(env, `/contents/${dir}`);
        if (r.ok) {
          const list = await r.json();
          out[t] = list.filter((f) => f.name.endsWith('.md')).map((f) => f.name.slice(0, -3));
        }
      }
      return json(out);
    }

    // Read one entry back so the editor can load it for editing.
    if (p === '/api/load') {
      const type = url.searchParams.get('type');
      const slug = slugify(url.searchParams.get('slug') || '');
      if (!DIRS[type] || !slug) return json({ error: 'Bad request.' }, 400);
      const r = await gh(env, `/contents/${encodeURI(`${DIRS[type]}/${slug}.md`)}`);
      if (r.status === 404) return json({ error: 'Not found.' }, 404);
      if (!r.ok) return json({ error: `GitHub ${r.status}` }, 502);
      const { content } = await r.json();
      // GitHub wraps base64 at 60 columns.
      const bin = atob(String(content).replace(/\n/g, ''));
      const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      return json({ raw: new TextDecoder().decode(bytes) });
    }

    if (p === '/api/upload' && req.method === 'POST') {
      let d;
      try { d = await req.json(); } catch { return json({ error: 'Bad request.' }, 400); }
      const types = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif' };
      const ext = types[d.mime];
      if (!ext) return json({ error: 'Unsupported image type.' }, 400);
      if (!d.data) return json({ error: 'Empty image.' }, 400);
      if (d.data.length * 0.75 > 5 * 1024 * 1024) return json({ error: 'Image larger than 5 MB.' }, 413);

      const base = slugify(d.name) || 'image';
      const file = `public/images/${base}-${Date.now().toString(36)}.${ext}`;
      try {
        await ghPut(env, file, d.data, `image: ${base}`);
      } catch (e) {
        return json({ error: e.message }, 502);
      }
      return json({ ok: true, url: `/${file.replace(/^public\//, '')}`, file });
    }

    if (p === '/api/save' && req.method === 'POST') {
      let d;
      try { d = await req.json(); } catch { return json({ error: 'Bad request.' }, 400); }
      const err = validate(d);
      if (err) return json({ error: err }, 400);

      const slug = slugify(d.type === 'word' ? d.word : d.title);
      if (!slug) return json({ error: 'Could not make a filename from that title.' }, 400);

      const file = `${DIRS[d.type]}/${slug}.md`;

      if (!d.overwrite && slugify(d.renameFrom || '') !== slug) {
        const exists = await gh(env, `/contents/${encodeURI(file)}`);
        if (exists.ok) return json({ error: `“${slug}” already exists.`, slug, exists: true }, 409);
      }

      // Editing a title changes the filename; drop the old file in the same
      // commit so a rename doesn't leave a stale duplicate behind.
      const oldSlug = slugify(d.renameFrom || '');
      const oldFile = oldSlug && oldSlug !== slug ? `${DIRS[d.type]}/${oldSlug}.md` : null;

      try {
        const present = await ghExistingPaths(env, oldFile ? [file, oldFile] : [file]);
        const updated = present.has(file);
        const changes = [{ path: file, content: buildMarkdown(d) }];
        if (oldFile && present.has(oldFile)) changes.push({ path: oldFile, delete: true });
        const msg = oldFile && present.has(oldFile)
          ? `rename: ${oldSlug} → ${slug}`
          : `${updatedVerb(d)}: ${slug}`;
        await ghCommit(env, changes, msg);
        return json({
          ok: true, slug, file,
          updated,
          url: `/${d.type === 'word' ? 'words' : 'blog'}/${slug}/`,
        });
      } catch (e) {
        return json({ error: e.message }, 502);
      }
    }

    if (p === '/api/delete' && req.method === 'POST') {
      let d;
      try { d = await req.json(); } catch { return json({ error: 'Bad request.' }, 400); }
      const items = Array.isArray(d.items) ? d.items : [];
      if (!items.length) return json({ error: 'Nothing selected.' }, 400);
      if (items.length > 50) return json({ error: 'Too many at once (max 50).' }, 400);

      const results = [];
      const targets = [];
      for (const it of items) {
        const type = it.type;
        const slug = slugify(it.slug);
        if (!DIRS[type] || !slug) {
          results.push({ ...it, ok: false, error: 'Bad item.' });
          continue;
        }
        targets.push({ type, slug, file: `${DIRS[type]}/${slug}.md` });
      }

      if (!targets.length) return json({ ok: false, results }, 400);

      try {
        const present = await ghExistingPaths(env, targets.map((t) => t.file));
        const doomed = targets.filter((t) => present.has(t.file));
        targets.filter((t) => !present.has(t.file))
          .forEach((t) => results.push({ ...t, ok: true, missing: true }));

        if (doomed.length) {
          const names = doomed.map((t) => t.slug);
          const message = names.length === 1
            ? `remove: ${names[0]}`
            : `remove ${names.length} entries: ${names.join(', ')}`.slice(0, 240);
          const { sha } = await ghCommit(env, doomed.map((t) => ({ path: t.file, delete: true })), message);
          doomed.forEach((t) => results.push({ ...t, ok: true, commit: sha }));
        }
        return json({ ok: results.every((r) => r.ok), results, commits: doomed.length ? 1 : 0 });
      } catch (e) {
        targets.forEach((t) => { if (!results.some((r) => r.slug === t.slug)) results.push({ ...t, ok: false, error: e.message }); });
        return json({ ok: false, results, error: e.message }, 502);
      }
    }

    return json({ error: 'Not found.' }, 404);
  },
};

const updatedVerb = (d) => (d.overwrite ? 'update' : 'add');
