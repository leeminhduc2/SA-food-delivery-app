import { mkdir, writeFile } from 'node:fs/promises';
await mkdir('public/images', { recursive: true });
const leaf = (x, y, r = 0, c = '#47794c') =>
  `<g transform="translate(${x} ${y}) rotate(${r})"><path d="M0 0Q-38-42 0-64Q38-42 0 0" fill="${c}"/><path d="M0 0V-54" stroke="#b9ca80" stroke-width="2"/></g>`;
const noodle = `<g fill="none" stroke="#f2dfaf" stroke-width="8" stroke-linecap="round">${Array.from({ length: 12 }, (_, i) => `<path d="M${150 + i * 9} 190 C${240 + i * 7} 100 ${360 - i * 3} 280 ${240 + i * 6} 280 S${160 + i * 5} 220 ${220 + i * 4} 180"/>`).join('')}</g>`;
const bowl = `<ellipse cx="300" cy="345" rx="155" ry="26" fill="#334c2b" opacity=".14"/><circle cx="300" cy="225" r="160" fill="#fffdf1"/><circle cx="300" cy="225" r="142" fill="#e4dec6"/><circle cx="300" cy="225" r="131" fill="#97723e"/><circle cx="300" cy="225" r="125" fill="#b98c51"/>${noodle}<g fill="#925c41" stroke="#774633" stroke-width="2"><path d="M290 155q20-35 68-2l-13 29-48 6z"/><path d="M304 205q25-33 63-11l-7 31-47 8z"/><path d="M230 255q30-30 67-13l-5 32-48 8z"/></g>${leaf(208, 202, -50)}${leaf(209, 204, 0)}${leaf(215, 215, 65, '#609755')}${leaf(367, 287, 130)}${leaf(360, 282, 70, '#5c8a4b')}<g fill="#e8dcad">${Array.from({ length: 8 }, (_, i) => `<rect x="${218 + i * 14}" y="${170 + (i % 3) * 35}" width="4" height="28" rx="2" transform="rotate(${i * 12} 280 225)"/>`).join('')}</g><circle cx="355" cy="135" r="28" fill="#83a34b"/><circle cx="355" cy="135" r="23" fill="#d6dc8c"/><path d="M335 120l40 30M338 150l34-30M331 134l47 2" stroke="#f0efba" stroke-width="2"/><g fill="#bb4931"><ellipse cx="258" cy="200" rx="7" ry="4"/><ellipse cx="326" cy="265" rx="8" ry="4"/><ellipse cx="301" cy="149" rx="7" ry="4"/></g><g fill="#3d7241">${Array.from({ length: 18 }, (_, i) => `<circle cx="${210 + ((i * 47) % 180)}" cy="${145 + ((i * 33) % 160)}" r="3"/>`).join('')}</g>`;
const pizza = `<ellipse cx="300" cy="350" rx="160" ry="20" fill="#734320" opacity=".16"/><circle cx="300" cy="225" r="161" fill="#f7eacb"/><circle cx="300" cy="225" r="150" fill="#c98d43"/><circle cx="300" cy="225" r="135" fill="#c85230"/><circle cx="300" cy="225" r="125" fill="#e2a650"/><g fill="#fbebba">${[
  [245, 155],
  [336, 150],
  [389, 222],
  [330, 289],
  [238, 286],
  [209, 217],
  [295, 221],
]
  .map(([x, y]) => `<ellipse cx="${x}" cy="${y}" rx="28" ry="25"/>`)
  .join('')}</g>${[
  [230, 195, -20],
  [340, 202, 80],
  [310, 305, 170],
  [265, 268, -70],
  [345, 135, 30],
]
  .map(([x, y, r]) => leaf(x, y, r))
  .join('')}<g fill="#a43f28">${[
  [276, 163],
  [366, 270],
  [252, 235],
  [305, 310],
  [206, 257],
  [307, 187],
]
  .map(([x, y]) => `<circle cx="${x}" cy="${y}" r="8"/>`)
  .join('')}</g>`;
const healthy = `<ellipse cx="300" cy="355" rx="155" ry="20" fill="#31532f" opacity=".12"/><circle cx="300" cy="225" r="164" fill="#fff8dc"/><circle cx="300" cy="225" r="143" fill="#d7d9a6"/>${Array.from({ length: 16 }, (_, i) => leaf(210 + (i % 5) * 35, 155 + Math.floor(i / 5) * 45, i * 34, i % 2 ? '#6b9749' : '#467a4b')).join('')}<g fill="#e39243" stroke="#ce7836" stroke-width="3">${[
  [330, 147],
  [365, 181],
  [346, 220],
  [389, 229],
  [341, 275],
  [375, 280],
]
  .map(
    ([x, y]) =>
      `<rect x="${x}" y="${y}" width="27" height="29" rx="5" transform="rotate(20 ${x} ${y})"/>`,
  )
  .join(
    '',
  )}</g><g fill="#e2c68a">${Array.from({ length: 30 }, (_, i) => `<circle cx="${204 + ((i * 13) % 100)}" cy="${250 + ((i * 19) % 70)}" r="7"/>`).join('')}</g><path d="M275 115q-72 45-27 108q42 11 54-58z" fill="#639143" stroke="#3e7139" stroke-width="8"/><path d="M269 132q-36 33-13 68q25 0 31-37z" fill="#c9d980"/><g fill="#c45434"><circle cx="214" cy="216" r="17"/><circle cx="313" cy="271" r="16"/><circle cx="312" cy="129" r="16"/></g>`;
const sandwich = `<ellipse cx="300" cy="337" rx="169" ry="23" fill="#8b653d" opacity=".15"/><g transform="rotate(-25 300 230)"><rect x="121" y="172" width="355" height="130" rx="65" fill="#be7b38"/><path d="M151 230q50-45 97-15t93-5 106 4v34H151z" fill="#437e44"/><path d="M154 235h291" stroke="#e9d6a0" stroke-width="14"/><path d="M162 249h274" stroke="#a74e37" stroke-width="13"/><path d="M162 256h273" stroke="#e9a550" stroke-width="8"/><path d="M136 215q4-73 69-74h194q66 4 66 73z" fill="#e3ad5d"/><g stroke="#f9d48c" stroke-width="8" stroke-linecap="round"><path d="M204 154l-15 38M266 150l-15 37M328 150l-15 38M390 156l-15 38"/></g></g>`;
const rice = `<circle cx="300" cy="225" r="160" fill="#fff8e4"/><circle cx="300" cy="225" r="139" fill="#ece1ba"/><ellipse cx="248" cy="215" rx="77" ry="92" fill="#fff5cf"/><g fill="#e9dcb2">${Array.from({ length: 60 }, (_, i) => `<ellipse cx="${196 + ((i * 13) % 95)}" cy="${150 + ((i * 17) % 133)}" rx="3" ry="6" transform="rotate(${i * 21} 248 215)"/>`).join('')}</g><path d="M309 166q70-38 96 31t-11 97q-46 13-90-30z" fill="#985633" stroke="#c68b4b" stroke-width="8"/><g stroke="#583522" stroke-width="5"><path d="M318 188l71 33M315 214l81 39M315 241l71 36"/></g><ellipse cx="279" cy="139" rx="53" ry="40" fill="#fffbed"/><circle cx="280" cy="137" r="24" fill="#eeb745"/>${leaf(358, 153, 70)}<g fill="#80a560" stroke="#c8d99e" stroke-width="4"><circle cx="196" cy="294" r="22"/><circle cx="226" cy="312" r="22"/><circle cx="258" cy="320" r="22"/></g>`;
for (const [name, content, bg] of [
  ['vietnamese', bowl, '#e9c9a7'],
  ['pizza', pizza, '#eadbb9'],
  ['healthy', healthy, '#d9e3c9'],
  ['sandwich', sandwich, '#e8d5b2'],
  ['rice', rice, '#ead7be'],
  ['hero', bowl, 'transparent'],
]) {
  await writeFile(
    `public/images/${name}.svg`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="440" viewBox="0 0 600 440"><rect width="600" height="440" fill="${bg}"/>${name === 'hero' ? `${leaf(90, 160, -60, '#a7ba85')}${leaf(493, 320, 150, '#a7ba85')}<path d="M459 118l52 234M473 115l52 234" stroke="#927349" stroke-width="8" stroke-linecap="round"/>` : ''}${content}</svg>`,
  );
}
