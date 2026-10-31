import { mkdir, writeFile } from 'node:fs/promises';
import { MOCK_RESTAURANTS, itemImage, restaurantImage } from '../server/domain/mock-catalog.js';

/**
 * Produce the per-asset image prompts for the fictional catalog.
 *
 * The workspace has no image-generation tool, so this script deliberately
 * writes prompts only. It never creates SVG, stock, gradient or placeholder
 * images that could be mistaken for real food photography.
 */

const STYLE =
  'Photorealistic professional food photography, shot on a full-frame camera with a 50mm lens at f/2.8, ' +
  'soft natural window light from the left, shallow depth of field, crisp focus on the food, ' +
  'appetising colour, realistic steam and texture, neutral ceramic tableware, linen napkin, ' +
  'warm restaurant ambience, no text, no watermark, no logo, no hands, no people, no illustration, ' +
  'not a 3D render, not a vector graphic.';

function coverPrompt(name: string, cuisine: string, district: string): string {
  return (
    `Editorial cover photo for a fictional ${cuisine} restaurant called "${name}" in ${district}, Hanoi. ` +
    `An inviting overhead spread of its signature dishes on a dark wooden table, ` +
    `a few bowls, herbs and chopsticks arranged naturally. ${STYLE}`
  );
}

function dishPrompt(name: string, description: string, cuisine: string): string {
  return (
    `Close-up hero photo of "${name}" (${cuisine} cuisine): ${description} ` +
    `Plated naturally on a simple ceramic dish, 45-degree angle, visible texture and garnish, ` +
    `restaurant table setting. ${STYLE}`
  );
}

const lines: string[] = [
  '# Mock catalog image prompts',
  '',
  'These prompts describe the raster food photography for the fictional catalog.',
  'The files below do **not exist yet**: this workspace has no image-generation',
  'tool, MCP image server or image API. Do not replace them with SVG, stock,',
  'screenshots or illustrations; run the prompts in an image tool and save each',
  'result at the exact path and size listed.',
  '',
  'Suggested size: 1600×1000 for covers, 1200×900 for dishes. WebP, quality 82.',
  '',
];

let total = 0;
for (const restaurant of MOCK_RESTAURANTS) {
  lines.push(`## ${restaurant.name}`, '');
  lines.push(`- File: \`public${restaurantImage(restaurant.slug)}\``);
  lines.push(`- Prompt: ${coverPrompt(restaurant.name, restaurant.cuisine, restaurant.district)}`);
  lines.push('');
  for (const menu of restaurant.menus) {
    for (const menuItem of menu.items) {
      lines.push(`### ${menuItem.name} — ${menuItem.price.toLocaleString('vi-VN')}đ`);
      lines.push(`- File: \`public${itemImage(menuItem.id)}\``);
      lines.push(
        `- Prompt: ${dishPrompt(menuItem.name, menuItem.description, restaurant.cuisine)}`,
      );
      lines.push('');
      total += 1;
    }
  }
}

await mkdir('docs', { recursive: true });
await writeFile('docs/MOCK_IMAGE_PROMPTS.md', lines.join('\n'), 'utf8');
console.log(
  `Wrote ${total} dish prompts and ${MOCK_RESTAURANTS.length} cover prompts to docs/MOCK_IMAGE_PROMPTS.md.`,
);
