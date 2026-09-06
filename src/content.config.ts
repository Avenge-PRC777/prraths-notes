import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const words = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/words' }),
  schema: z.object({
    word: z.string(),
    pronunciation: z.string().optional(),
    partOfSpeech: z.string().optional(),
    meaning: z.string(),
    examples: z.array(z.string()).default([]),
    etymology: z.string().optional(),
    tags: z.array(z.string()).default([]),
    added: z.coerce.date(),
  }),
});

const blog = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/blog' }),
  schema: z.object({
    title: z.string(),
    blurb: z.string(),
    tags: z.array(z.string()).default([]),
    added: z.coerce.date(),
  }),
});

export const collections = { words, blog };
