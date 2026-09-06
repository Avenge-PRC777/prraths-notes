import { getCollection } from 'astro:content';

const url = { words: '/words', blog: '/blog' };

// Every entry, with the [[slugs]] it mentions — used to build a reverse index.
export async function graph() {
  const cols = await Promise.all(
    ['words', 'blog'].map(async (c) =>
      (await getCollection(c)).map((e) => ({
        col: c,
        id: e.id,
        url: `${url[c]}/${e.id}/`,
        title: c === 'words' ? e.data.word : e.data.title,
        type: c === 'words' ? 'word' : 'blog',
        mentions: [...(e.body || '').matchAll(/\[\[([^\]|]+)/g)].map((m) => m[1].trim().toLowerCase()),
      }))
    )
  );
  return cols.flat();
}

export async function backlinksFor(id) {
  const all = await graph();
  return all.filter((e) => e.id !== id && e.mentions.includes(id.toLowerCase()));
}
