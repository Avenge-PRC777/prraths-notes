import { getCollection } from 'astro:content';

export async function GET() {
  const [words, blog] = await Promise.all([
    getCollection('words'), getCollection('blog'),
  ]);

  const strip = (s = '') => s.replace(/```[\s\S]*?```/g, ' ').replace(/[#*_>\[\]()`|-]/g, ' ').replace(/\s+/g, ' ').trim();

  const index = [
    ...words.map((e) => ({
      t: 'word',
      url: `/words/${e.id}/`,
      title: e.data.word,
      sub: e.data.meaning,
      tags: e.data.tags,
      date: e.data.added.toISOString().slice(0, 10),
      body: strip([e.data.meaning, ...e.data.examples, e.data.etymology, e.data.pronunciation, e.body].join(' ')).slice(0, 1200),
    })),
    ...blog.map((e) => ({
      t: 'blog',
      url: `/blog/${e.id}/`,
      title: e.data.title,
      sub: e.data.blurb,
      tags: e.data.tags,
      date: e.data.added.toISOString().slice(0, 10),
      body: strip([e.data.blurb, e.body].join(' ')).slice(0, 1200),
    })),
  ];

  return new Response(JSON.stringify(index), {
    headers: { 'Content-Type': 'application/json' },
  });
}
