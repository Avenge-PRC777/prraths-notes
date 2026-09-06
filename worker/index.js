/**
 * Serves the static site, plus a private /write editor that commits
 * Markdown straight to GitHub.
 *
 * Secrets (set in Cloudflare, never in the repo):
 *   ADMIN_PASSWORD_HASH  sha256 hex of the passphrase
 *   SESSION_SECRET       random string used to sign session cookies
 *   GITHUB_TOKEN         fine-grained PAT, Contents: read+write on this repo
 *   GITHUB_REPO          e.g. "Avenge-PRC777/prraths-notes"
 */

const COOKIE = 'wd_session';
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

const b64 = (str) => {
  const bytes = enc.encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};

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
      for (const [t, dir] of [['word', 'src/content/words'], ['blog', 'src/content/blog']]) {
        const r = await gh(env, `/contents/${dir}`);
        if (r.ok) {
          const list = await r.json();
          out[t] = list.filter((f) => f.name.endsWith('.md')).map((f) => f.name.slice(0, -3));
        }
      }
      return json(out);
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

      const dir = d.type === 'word' ? 'src/content/words' : 'src/content/blog';
      const file = `${dir}/${slug}.md`;

      if (!d.overwrite) {
        const exists = await gh(env, `/contents/${encodeURI(file)}`);
        if (exists.ok) return json({ error: `“${slug}” already exists.`, slug, exists: true }, 409);
      }

      try {
        const { updated } = await ghPut(env, file, b64(buildMarkdown(d)), `${updatedVerb(d)}: ${slug}`);
        return json({
          ok: true, slug, file,
          updated,
          url: `/${d.type === 'word' ? 'words' : 'blog'}/${slug}/`,
        });
      } catch (e) {
        return json({ error: e.message }, 502);
      }
    }

    return json({ error: 'Not found.' }, 404);
  },
};

const updatedVerb = (d) => (d.overwrite ? 'update' : 'add');
