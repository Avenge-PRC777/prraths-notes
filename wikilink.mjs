import { visit } from 'unist-util-visit';

// Map a [[slug]] to whichever collection actually contains it, at build time.
export function wikiLink({ resolve }) {
  return (tree) => {
    visit(tree, 'text', (node, i, parent) => {
      const re = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
      if (!re.test(node.value)) return;
      re.lastIndex = 0;
      const out = [];
      let last = 0, m;
      while ((m = re.exec(node.value))) {
        if (m.index > last) out.push({ type: 'text', value: node.value.slice(last, m.index) });
        const slug = m[1].trim();
        const label = (m[2] || slug).trim();
        const url = resolve(slug);
        out.push(url
          ? { type: 'link', url, data: { hProperties: { class: 'wikilink' } }, children: [{ type: 'text', value: label }] }
          : { type: 'text', value: label });
        last = m.index + m[0].length;
      }
      if (last < node.value.length) out.push({ type: 'text', value: node.value.slice(last) });
      parent.children.splice(i, 1, ...out);
      return i + out.length;
    });
  };
}
