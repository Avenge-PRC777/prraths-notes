#!/usr/bin/env node
// Add an entry without touching frontmatter by hand:
//   npm run new word "petrichor"
//   npm run new concept "Survivorship bias"
//   npm run new blog "Why I keep this"
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';

const [type, ...rest] = process.argv.slice(2);
const title = rest.join(' ').trim();

if (!['word', 'concept', 'blog'].includes(type) || !title) {
  console.log('Usage: npm run new <word|concept|blog> "<title>"');
  process.exit(1);
}

const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const dir = { word: 'words', concept: 'concepts', blog: 'blog' }[type];
const file = path.join('src/content', dir, `${slug}.md`);

if (fs.existsSync(file)) {
  console.log(`Already exists: ${file}`);
  process.exit(1);
}

const today = new Date().toISOString().slice(0, 10);
const tty = process.stdin.isTTY;
// Interactive: prompt one at a time. Piped (tests/scripts): consume queued lines.
let queue = [];
if (!tty) {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  queue = Buffer.concat(chunks).toString().split('\n');
}
const rl = tty ? readline.createInterface({ input: process.stdin, output: process.stdout }) : null;
const ask = async (q, d = '') => {
  const a = tty
    ? await rl.question(`${q}${d ? ` (${d})` : ''}: `).catch(() => '')
    : (queue.shift() ?? '');
  return a.trim() || d;
};

let body;
if (type === 'word') {
  const meaning = await ask('Meaning');
  const example = await ask('Example sentence');
  const pos = await ask('Part of speech', 'noun');
  const tags = await ask('Tags, comma separated', pos);
  body = `---
word: ${title}
partOfSpeech: ${pos}
meaning: ${JSON.stringify(meaning)}
examples:
  - ${JSON.stringify(example)}
tags: [${tags.split(',').map(t => t.trim()).filter(Boolean).join(', ')}]
added: ${today}
---
`;
} else if (type === 'concept') {
  const summary = await ask('One-line summary');
  const field = await ask('Field', 'thinking');
  const tags = await ask('Tags, comma separated', field);
  body = `---
title: ${JSON.stringify(title)}
summary: ${JSON.stringify(summary)}
field: ${field}
tags: [${tags.split(',').map(t => t.trim()).filter(Boolean).join(', ')}]
added: ${today}
---

## The plain version

`;
} else {
  const blurb = await ask('Blurb');
  const tags = await ask('Tags, comma separated', 'writing');
  body = `---
title: ${JSON.stringify(title)}
blurb: ${JSON.stringify(blurb)}
tags: [${tags.split(',').map(t => t.trim()).filter(Boolean).join(', ')}]
added: ${today}
---

`;
}

rl?.close();
fs.writeFileSync(file, body);
console.log(`\n✓ ${file}\n  Open it, finish the body, then: git add -A && git commit -m "${slug}" && git push`);
