// The content module is the common source for the web guide and printable copies.
import { writeFile } from 'node:fs/promises';
import { chapters, viewMap } from '../js/guide-content.js';
const lines = [
  '# Tiksi user guide', '',
  'A screenshot walkthrough of capture, design, materials and project work.', '',
  '[Open the interactive guide](https://mattadurham.github.io/tiksi/#/guide) · [Download the PDF](js/guide-assets/tiksi-user-guide.pdf)', '',
  'Open **GUIDE** at the top of Tiksi for chapter search, expandable screenshots and short recordings. The screenshots use a synthetic sample property with drawn reference images and fictional products/prices. They contain no owner project data.', '',
  '## Contents', '',
  ...chapters.map(chapter => `- [${chapter.title}](#${chapter.id})`), '',
];
for (const chapter of chapters) {
  lines.push(`<a id="${chapter.id}"></a>`, '', `## ${chapter.title}`, '');
  if (chapter.path) lines.push(`**Where:** ${chapter.path}`, '');
  lines.push(chapter.intro, '');
  if (chapter.image) lines.push(`![${chapter.alt || chapter.caption}](js/guide-assets/${chapter.image})`, '', chapter.caption, '');
  if (chapter.id === 'start') {
    lines.push('### Where everything lives', '', '| Workspace | Use it for |', '| --- | --- |', ...viewMap.map(view => `| ${view.label} | ${view.purpose} |`), '');
  }
  if (chapter.steps?.length) lines.push(`### ${chapter.stepsTitle || 'Try it'}`, '', ...chapter.steps.map((step, index) => `${index + 1}. ${step}`), '');
  if (chapter.clip) lines.push(`<details><summary>${chapter.clipTitle}</summary>`, '', `![${chapter.clipTitle}](js/guide-assets/${chapter.gif})`, '', chapter.transcript, '', `[Download the video](js/guide-assets/${chapter.clip})`, '', '</details>', '');
  if (chapter.features?.length) lines.push('### Other features here', '', ...chapter.features.flatMap(([name, description]) => [`**${name}.** ${description}`, '']));
  if (chapter.note) lines.push(`> **${chapter.noteTitle || 'Good to know'}:** ${chapter.note}`, '');
}
lines.push('---', '', 'The guide is generated from `js/guide-content.js`. Screenshots and demos are reproducible with `tools/capture-guide.mjs` and the synthetic `tools/guide-fixture.mjs`; capture runs refuse the live port. Rebuild this Markdown copy with `node tools/build-guide-markdown.mjs`.', '');
await writeFile(new URL('../USER-GUIDE.md', import.meta.url), lines.join('\n'));
console.log('Updated USER-GUIDE.md from shared guide content');
