# prrath.notes

Words and writing — one place, one search box.
Public to read, private to edit (only you can push).

## Daily use

```bash
npm run admin    # → localhost:4444, the admin desk (write + delete)
```

Split screen: fields and a markdown box on the left, the finished entry
rendered on the right as you type. Toggle Word / Blog at the top. Hit Save
(or Cmd-S) and it writes the .md file into src/content/ for you — no
frontmatter to hand-write, no YAML to get wrong. Drafts survive a reload.

**Images:** paste from the clipboard (Cmd-V) or drag a file straight into the
markdown box. The file lands in `public/images/` and the markdown is inserted
for you. Screenshots, photos, diagrams — PNG, JPEG, GIF, WebP, AVIF, up to 8 MB.

Then:

```bash
git add -A && git commit -m "petrichor" && git push
```

There's also a terminal version if you prefer: `npm run new word "petrichor"`.

The site rebuilds and redeploys itself in ~30 seconds.

## Deploying (one time, ~5 minutes)

1. **Put it on GitHub**
   ```bash
   gh repo create prraths-notes --private --source=. --push
   ```
   (or make an empty repo on github.com and `git remote add origin … && git push -u origin main`)

   The repo can be **private** — the published site is still public. Private repo = nobody
   can edit or see drafts; public site = anyone can read the finished pages.

2. **Connect Cloudflare Pages**
   - dash.cloudflare.com → *Workers & Pages* → *Create* → *Pages* → *Connect to Git*
   - Pick the repo
   - Build command: `npm run build`
   - Output directory: `dist`
   - Save and Deploy

3. You get `prraths-notes.pages.dev`. Every `git push` from then on redeploys automatically.

4. **Custom domain (optional)** — buy one anywhere (~₹800/yr), then Pages → *Custom domains* → add it.
   Update `site:` in `astro.config.mjs` to match.

Netlify and Vercel work identically with the same build command and output dir.

## How it's put together

```
src/content/words/*.md      one file per word
src/content/blog/*.md       one file per post
src/content.config.ts       the required fields for each
```

**Search** — `/search-index.json` is generated at build time from both collections
(titles, meanings, examples, tags, body text). The browser fetches it once on first
keystroke and filters in memory, so results appear instantly with no server.
Ranking: exact title > title prefix > title contains > tag > summary > body.

**Wikilinks** — write `[[survivorship-bias]]` in any file and it becomes a link, whichever
collection that slug lives in. The target page automatically grows a "Mentioned in" panel
pointing back. No manual bookkeeping.

**Tags** — `tags: [noun, thinking]` in frontmatter; `/tags/thinking/` pages build themselves.

**Keyboard** — `/` focuses search anywhere, `↑`/`↓` move through results, `↵` opens, `Esc` clears.

**Theme** — follows your OS, toggle in the header, remembered per browser.

## Adding a field

Edit `src/content.config.ts`, add it to the Zod schema, then use it in the matching
`src/pages/<type>/[...id].astro`. Astro will refuse to build if a file is missing a
required field — which is the point.
