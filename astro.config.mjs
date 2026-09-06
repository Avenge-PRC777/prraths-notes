import { defineConfig } from 'astro/config';
import { unified } from '@astrojs/markdown-remark';
import fs from 'node:fs';
import { wikiLink } from './wikilink.mjs';

// Build a slug -> url map from the content folders, so [[foo]] resolves
// no matter which collection `foo` lives in.
const map = {};
for (const [dir, base] of [['words', '/words'], ['concepts', '/concepts'], ['blog', '/blog']]) {
  const p = `./src/content/${dir}`;
  if (!fs.existsSync(p)) continue;
  for (const f of fs.readdirSync(p)) {
    if (f.endsWith('.md')) map[f.replace(/\.md$/, '').toLowerCase()] = `${base}/${f.replace(/\.md$/, '')}/`;
  }
}

export default defineConfig({
  site: 'https://prraths-notes.pages.dev',
  markdown: {
    processor: (() => {
      const p = unified();
      p.options.remarkPlugins.push(() => wikiLink({ resolve: (s) => map[s.toLowerCase().replace(/\s+/g, '-')] }));
      return p;
    })(),
    shikiConfig: { themes: { light: 'github-light', dark: 'github-dark' } },
  },
});
