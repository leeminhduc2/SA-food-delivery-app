import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CURATED_HANOI_RESTAURANTS,
  hashString,
  MENU_PROFILES,
  type MenuProfileKey,
} from '../server/modules/catalog/import/hanoi.js';

/**
 * Generate the project-owned SVG illustrations used by the Hanoi demo data.
 *
 * These are deliberately abstract illustrations, not photographs. Every file
 * lives under `public/images` with a lowercase name that the API image schema
 * accepts. Re-running the script is deterministic.
 */

const output = join(process.cwd(), 'public', 'images');
mkdirSync(output, { recursive: true });

const dishKeys = [
  ...new Set(
    Object.values(MENU_PROFILES).flatMap((profile) =>
      profile.categories.flatMap((category) => category.items.map((item) => item.imageKey)),
    ),
  ),
].sort();

const palettes = [
  ['#f6ead8', '#d8a25e', '#7c3f2c'],
  ['#eef0df', '#9bb56b', '#33543d'],
  ['#f8e2dd', '#d97a66', '#6f2f35'],
  ['#e7eef0', '#7da9ae', '#294d55'],
  ['#f3e8ce', '#c79a3d', '#5a4520'],
  ['#ece4f0', '#a183b5', '#463254'],
  ['#f7e9d3', '#cf8a44', '#60371f'],
  ['#e5f0e6', '#6fa382', '#244b38'],
  ['#f5e6e1', '#c36f5d', '#5b2c27'],
] as const;

const esc = (value: string) =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

function leaf(x: number, y: number, rotate: number, fill: string): string {
  return `<path d="M0 0C15-18 35-18 46 0C34 20 14 22 0 0Z" fill="${fill}" transform="translate(${x} ${y}) rotate(${rotate})"/>`;
}

function bowl(key: string, colors: readonly [string, string, string]): string {
  const [light, mid, dark] = colors;
  const noodle = key === 'ramen' || key === 'pho' || key === 'bun-cha' || key === 'noodles';
  const curry = key === 'curry' || key === 'soup';
  const padThai = key === 'pad-thai';
  return `
    <ellipse cx="400" cy="410" rx="240" ry="54" fill="#2a1c15" opacity=".16"/>
    <path d="M170 285C176 420 260 500 400 500C540 500 624 420 630 285Z" fill="${dark}"/>
    <ellipse cx="400" cy="286" rx="230" ry="72" fill="${mid}"/>
    <ellipse cx="400" cy="286" rx="198" ry="52" fill="${curry ? '#d88435' : '#f4d79a'}"/>
    ${
      noodle
        ? `<g stroke="#fff4cf" stroke-width="9" fill="none" stroke-linecap="round" opacity=".95">
             <path d="M250 286c50-34 105-34 155 0s105 34 155 0"/>
             <path d="M270 310c44-28 92-28 136 0s92 28 136 0"/>
             <path d="M300 258c34-20 70-20 104 0s70 20 104 0"/>
           </g>`
        : ''
    }
    ${
      padThai
        ? `<g stroke="#e6a847" stroke-width="10" fill="none" stroke-linecap="round">
             <path d="M250 292c38-28 78-28 116 0s78 28 116 0"/>
             <path d="M280 316c34-24 70-24 104 0s70 24 104 0"/>
           </g><circle cx="326" cy="266" r="16" fill="#c94c3f"/><circle cx="470" cy="306" r="13" fill="#f6df8b"/>`
        : ''
    }
    ${
      curry
        ? `<circle cx="330" cy="276" r="31" fill="#f5e2a4"/><circle cx="458" cy="300" r="26" fill="#b84b2f"/><circle cx="400" cy="258" r="22" fill="#7e9a52"/>`
        : ''
    }
    <g fill="${light}">
      <circle cx="330" cy="266" r="24"/>
      <circle cx="402" cy="248" r="19"/>
      <circle cx="470" cy="280" r="24"/>
    </g>
    <g fill="#6c8d43">
      <ellipse cx="360" cy="252" rx="26" ry="10" transform="rotate(-24 360 252)"/>
      <ellipse cx="438" cy="266" rx="24" ry="9" transform="rotate(18 438 266)"/>
      <ellipse cx="393" cy="226" rx="22" ry="8" transform="rotate(72 393 226)"/>
    </g>
    <g stroke="#f8f1df" stroke-width="7" stroke-linecap="round" opacity=".85">
      <path d="M330 198c-18-24 18-34 0-58"/>
      <path d="M400 190c-18-24 18-34 0-58"/>
      <path d="M470 198c-18-24 18-34 0-58"/>
    </g>`;
}

function plate(key: string, colors: readonly [string, string, string]): string {
  const [light, mid, dark] = colors;
  const sushi = key === 'sushi';
  const pizza = key === 'pizza';
  const burger = key === 'burger' || key === 'sandwich' || key === 'banh-mi';
  const steak = key === 'steak';
  const salad = key === 'salad';
  const grill = key === 'grill' || key === 'seafood';
  const dessert = key === 'dessert';
  const bread = key === 'bread';
  const rolls = key === 'spring-rolls' || key === 'fried-rolls' || key === 'tempura';
  const breakfast = key === 'breakfast';
  const rice = key === 'rice';
  const pasta = key === 'pasta';
  return `
    <ellipse cx="400" cy="414" rx="250" ry="48" fill="#2a1c15" opacity=".16"/>
    <ellipse cx="400" cy="330" rx="250" ry="170" fill="#fffdf5"/>
    <ellipse cx="400" cy="330" rx="214" ry="138" fill="${light}"/>
    ${
      pizza
        ? `<circle cx="400" cy="324" r="118" fill="#e8b45a"/><circle cx="400" cy="324" r="102" fill="#d45d37"/>
           <g fill="#f5e2a4"><circle cx="350" cy="282" r="17"/><circle cx="448" cy="296" r="16"/><circle cx="390" cy="366" r="15"/><circle cx="470" cy="360" r="12"/></g>
           <g stroke="#7c9c4d" stroke-width="9" stroke-linecap="round"><path d="M340 342l36-18"/><path d="M430 270l22 30"/><path d="M410 390l-28-20"/></g>`
        : ''
    }
    ${
      sushi
        ? `<g><rect x="260" y="286" width="86" height="52" rx="24" fill="#fff6e8"/><rect x="270" y="272" width="66" height="26" rx="13" fill="#e47c5c"/>
             <rect x="358" y="316" width="86" height="52" rx="24" fill="#fff6e8"/><rect x="368" y="302" width="66" height="26" rx="13" fill="#d98962"/>
             <rect x="456" y="276" width="86" height="52" rx="24" fill="#fff6e8"/><rect x="466" y="262" width="66" height="26" rx="13" fill="#e47c5c"/>
             <circle cx="522" cy="354" r="12" fill="#7e9a52"/><circle cx="286" cy="364" r="10" fill="#7e9a52"/></g>`
        : ''
    }
    ${
      burger
        ? `<g><path d="M286 292c0-52 42-82 114-82s114 30 114 82Z" fill="#d99a4e"/>
             <rect x="276" y="296" width="248" height="26" rx="13" fill="#7c9c4d"/>
             <rect x="282" y="322" width="236" height="38" rx="16" fill="${dark}"/>
             <rect x="276" y="360" width="248" height="22" rx="11" fill="#e8b45a"/>
             <path d="M282 388c18 42 218 42 236 0Z" fill="#d99a4e"/></g>`
        : ''
    }
    ${
      steak
        ? `<path d="M286 274c28-42 78-54 122-34c38 17 68 8 92 28c26 22 20 62-6 84c-32 28-84 18-120 6c-38-13-76-8-94-34c-10-16-6-34 6-50Z" fill="${dark}"/>
           <path d="M320 286c22-20 52-22 76-8c20 12 36 4 50 16" stroke="#b96b51" stroke-width="12" fill="none" stroke-linecap="round"/>
           <g fill="#e8b45a"><rect x="468" y="362" width="16" height="54" rx="7" transform="rotate(-18 468 362)"/><rect x="492" y="356" width="16" height="54" rx="7" transform="rotate(12 492 356)"/><rect x="516" y="366" width="16" height="54" rx="7" transform="rotate(-6 516 366)"/></g>`
        : ''
    }
    ${
      salad
        ? `<g fill="#6f9c54"><circle cx="330" cy="314" r="44"/><circle cx="400" cy="286" r="52"/><circle cx="470" cy="320" r="46"/><circle cx="390" cy="360" r="40"/></g>
           <g fill="#c94c3f"><circle cx="344" cy="350" r="16"/><circle cx="446" cy="286" r="14"/><circle cx="420" cy="382" r="12"/></g>
           <g fill="#f1cf67"><circle cx="312" cy="284" r="10"/><circle cx="476" cy="356" r="9"/></g>`
        : ''
    }
    ${
      grill
        ? `<g stroke="${dark}" stroke-width="12" stroke-linecap="round"><path d="M286 276l228 104"/><path d="M286 380l228-104"/></g>
           <g fill="${mid}"><circle cx="330" cy="302" r="28"/><circle cx="390" cy="330" r="32"/><circle cx="456" cy="352" r="28"/><circle cx="480" cy="300" r="24"/></g>
           <g fill="#7c9c4d"><ellipse cx="310" cy="366" rx="28" ry="12" transform="rotate(-20 310 366)"/><ellipse cx="500" cy="374" rx="24" ry="10" transform="rotate(18 500 374)"/></g>`
        : ''
    }
    ${
      dessert
        ? `<path d="M300 366l100-118l100 118Z" fill="#e8b45a"/><path d="M330 366l70-82l70 82Z" fill="#fff1cf"/>
           <circle cx="400" cy="246" r="20" fill="#c94c3f"/><path d="M400 246c-4-26 12-36 28-40" stroke="#6f9c54" stroke-width="8" fill="none" stroke-linecap="round"/>`
        : ''
    }
    ${
      bread
        ? `<g><ellipse cx="342" cy="322" rx="70" ry="46" fill="#d99a4e" transform="rotate(-12 342 322)"/><ellipse cx="456" cy="330" rx="70" ry="46" fill="#cf8a44" transform="rotate(9 456 330)"/>
             <path d="M300 314c26-22 64-22 90 0" stroke="#f5dfae" stroke-width="10" fill="none" stroke-linecap="round"/><path d="M414 322c26-22 64-22 90 0" stroke="#f5dfae" stroke-width="10" fill="none" stroke-linecap="round"/></g>`
        : ''
    }
    ${
      rolls
        ? `<g><rect x="276" y="286" width="116" height="54" rx="26" fill="#dc9a4b" transform="rotate(-8 276 286)"/>
             <rect x="318" y="330" width="126" height="54" rx="26" fill="#e2a758" transform="rotate(7 318 330)"/>
             <rect x="420" y="286" width="126" height="54" rx="26" fill="#d89243" transform="rotate(-4 420 286)"/>
             <g fill="#6f9c54"><circle cx="320" cy="312" r="10"/><circle cx="378" cy="356" r="10"/><circle cx="480" cy="312" r="10"/></g></g>`
        : ''
    }
    ${
      breakfast
        ? `<g><circle cx="326" cy="304" r="48" fill="#fffdf5"/><circle cx="326" cy="304" r="20" fill="#e8b45a"/>
             <circle cx="416" cy="330" r="46" fill="#fffdf5"/><circle cx="416" cy="330" r="19" fill="#e8b45a"/>
             <rect x="452" y="270" width="82" height="58" rx="12" fill="#d99a4e" transform="rotate(9 452 270)"/>
             <circle cx="360" cy="382" r="18" fill="#c94c3f"/><ellipse cx="300" cy="382" rx="24" ry="10" fill="#6f9c54"/></g>`
        : ''
    }
    ${
      rice
        ? `<path d="M296 342c0-52 46-86 104-86s104 34 104 86c0 30-44 48-104 48s-104-18-104-48Z" fill="#fff6e0"/>
           <g fill="#6f9c54"><ellipse cx="330" cy="300" rx="26" ry="10" transform="rotate(-18 330 300)"/><ellipse cx="470" cy="318" rx="24" ry="9" transform="rotate(16 470 318)"/></g>
           <circle cx="384" cy="320" r="34" fill="#e8b45a"/><circle cx="430" cy="296" r="24" fill="${dark}"/>`
        : ''
    }
    ${
      pasta
        ? `<g stroke="#e6b45c" stroke-width="11" fill="none" stroke-linecap="round">
             <path d="M300 334c38-48 88-48 126 0s88 48 126 0"/>
             <path d="M316 364c34-36 76-36 110 0s76 36 110 0"/>
             <path d="M342 304c24-28 56-28 80 0s56 28 80 0"/>
           </g><g fill="#c94c3f"><circle cx="356" cy="292" r="16"/><circle cx="462" cy="340" r="15"/></g>`
        : ''
    }
    <g stroke="#d9c9ae" stroke-width="3" opacity=".5"><circle cx="400" cy="330" r="196" fill="none"/></g>`;
}

function cup(key: string, colors: readonly [string, string, string]): string {
  const [light, mid, dark] = colors;
  const smoothie = key === 'smoothie';
  return `
    <ellipse cx="400" cy="438" rx="190" ry="36" fill="#2a1c15" opacity=".16"/>
    <ellipse cx="400" cy="422" rx="150" ry="38" fill="#fffdf5"/>
    ${
      smoothie
        ? `<path d="M320 206h160l-18 216h-124Z" fill="${mid}"/><path d="M334 226h132l-6 74H340Z" fill="#f3c46b"/><rect x="430" y="170" width="13" height="170" rx="6" fill="${dark}" transform="rotate(12 430 170)"/>`
        : `<path d="M328 220h144l-16 190c-2 18-18 30-36 30h-40c-18 0-34-12-36-30Z" fill="#fffdf5"/><path d="M344 244h112l-10 146c-1 10-10 18-20 18h-52c-10 0-19-8-20-18Z" fill="${mid}"/><ellipse cx="400" cy="244" rx="56" ry="16" fill="${dark}"/>`
    }
    ${
      key === 'coffee'
        ? `<path d="M470 280c42 0 46 62 0 62" stroke="#fffdf5" stroke-width="16" fill="none"/><path d="M368 196c-16-24 16-32 0-56M400 190c-16-24 16-32 0-56" stroke="#f8f1df" stroke-width="8" fill="none" stroke-linecap="round"/>`
        : ''
    }
    ${
      key === 'tea'
        ? `<circle cx="454" cy="272" r="24" fill="#f1cf67"/><path d="M330 262c44-18 96-18 140 0" stroke="#8cad5b" stroke-width="8" fill="none"/>`
        : ''
    }
    ${
      key === 'drink'
        ? `<circle cx="454" cy="270" r="18" fill="#c94c3f"/><g fill="#fffdf5" opacity=".5"><circle cx="368" cy="300" r="8"/><circle cx="392" cy="284" r="6"/><circle cx="420" cy="318" r="7"/></g>`
        : ''
    }
    <g fill="#6f9c54">${leaf(318, 400, -24, '#6f9c54')}${leaf(482, 400, 24, '#8cad5b')}</g>
    <g stroke="#d9c9ae" stroke-width="3" opacity=".55"><path d="M300 410h200"/></g>`;
}

function dishSvg(key: string): string {
  const colors = palettes[hashString(key) % palettes.length];
  const cupKey = ['coffee', 'tea', 'drink', 'smoothie'].includes(key);
  const bowlKey = ['pho', 'bun-cha', 'ramen', 'noodles', 'soup', 'curry', 'pad-thai'].includes(key);
  const art = cupKey ? cup(key, colors) : bowlKey ? bowl(key, colors) : plate(key, colors);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600" role="img" aria-label="Illustration of ${esc(key.replaceAll('-', ' '))}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${colors[0]}"/><stop offset="1" stop-color="#fffdf7"/>
    </linearGradient>
    <radialGradient id="glow" cx=".32" cy=".2" r=".8">
      <stop offset="0" stop-color="#ffffff" stop-opacity=".85"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="800" height="600" fill="url(#bg)"/>
  <rect width="800" height="600" fill="url(#glow)"/>
  <g opacity=".18" stroke="${colors[2]}" stroke-width="2">
    <path d="M40 520C170 470 230 560 360 510s190-40 400 20"/>
    <path d="M40 548C170 498 230 588 360 538s190-40 400 20"/>
  </g>
  ${art}
  <g fill="${colors[2]}" opacity=".8">
    <text x="34" y="560" font-family="Georgia, serif" font-size="20" letter-spacing="4">BẾP · MINH HOẠ</text>
    <text x="766" y="560" text-anchor="end" font-family="Georgia, serif" font-size="14" letter-spacing="2">DEMO ASSET</text>
  </g>
</svg>`;
}

const coverMotifs: Record<MenuProfileKey, string> = {
  vietnamese: `<path d="M470 300C476 420 550 486 664 486C778 486 852 420 858 300Z" fill="#4c2c22"/><ellipse cx="664" cy="300" rx="200" ry="62" fill="#c07845"/><ellipse cx="664" cy="300" rx="168" ry="44" fill="#f4d79a"/><g stroke="#fff4cf" stroke-width="8" fill="none" stroke-linecap="round"><path d="M520 300c44-26 92-26 136 0s92 26 136 0"/><path d="M548 324c38-22 78-22 116 0s78 22 116 0"/></g><g fill="#6c8d43"><ellipse cx="610" cy="276" rx="26" ry="10" transform="rotate(-18 610 276)"/><ellipse cx="700" cy="290" rx="24" ry="9" transform="rotate(14 700 290)"/></g>`,
  japanese: `<ellipse cx="664" cy="330" rx="210" ry="160" fill="#fffdf5"/><g><rect x="520" y="298" width="94" height="56" rx="26" fill="#fff6e8"/><rect x="532" y="282" width="70" height="28" rx="14" fill="#e47c5c"/><rect x="632" y="330" width="94" height="56" rx="26" fill="#fff6e8"/><rect x="644" y="314" width="70" height="28" rx="14" fill="#e47c5c"/><rect x="744" y="292" width="94" height="56" rx="26" fill="#fff6e8"/><rect x="756" y="276" width="70" height="28" rx="14" fill="#e47c5c"/></g>`,
  indian: `<ellipse cx="664" cy="330" rx="210" ry="150" fill="#f2dfb4"/><circle cx="664" cy="330" r="112" fill="#b8562f"/><circle cx="664" cy="330" r="88" fill="#d88435"/><g fill="#f5e2a4"><circle cx="620" cy="300" r="22"/><circle cx="700" cy="340" r="18"/><circle cx="650" cy="376" r="16"/></g><g fill="#6c8d43"><ellipse cx="724" cy="292" rx="24" ry="10" transform="rotate(18 724 292)"/></g>`,
  thai: `<ellipse cx="664" cy="336" rx="212" ry="154" fill="#fffdf5"/><g stroke="#e6a847" stroke-width="12" fill="none" stroke-linecap="round"><path d="M510 330c48-38 96-38 144 0s96 38 144 0"/><path d="M540 366c40-30 80-30 120 0s80 30 120 0"/></g><circle cx="584" cy="306" r="20" fill="#c94c3f"/><circle cx="748" cy="352" r="17" fill="#f6df8b"/><g fill="#6c8d43"><ellipse cx="690" cy="278" rx="26" ry="10" transform="rotate(12 690 278)"/></g>`,
  french: `<ellipse cx="664" cy="330" rx="210" ry="160" fill="#fffdf5"/><path d="M540 294c30-42 76-54 116-34c36 17 64 8 88 28c26 22 20 62-6 84c-32 28-82 18-116 6c-38-13-74-8-92-34c-10-16-4-34 10-50Z" fill="#5b2c27"/><g fill="#e8b45a"><rect x="730" y="358" width="16" height="54" rx="7" transform="rotate(-18 730 358)"/><rect x="754" y="352" width="16" height="54" rx="7" transform="rotate(12 754 352)"/></g>`,
  international: `<ellipse cx="664" cy="330" rx="210" ry="160" fill="#fffdf5"/><circle cx="664" cy="326" r="116" fill="#e8b45a"/><circle cx="664" cy="326" r="100" fill="#d45d37"/><g fill="#f5e2a4"><circle cx="616" cy="286" r="17"/><circle cx="710" cy="300" r="16"/><circle cx="650" cy="368" r="15"/></g><g stroke="#7c9c4d" stroke-width="9" stroke-linecap="round"><path d="M606 344l36-18"/><path d="M694 272l22 30"/></g>`,
  cafe: `<ellipse cx="664" cy="420" rx="170" ry="38" fill="#5b2c27" opacity=".18"/><path d="M584 272h160l-18 150c-2 16-16 28-32 28h-60c-16 0-30-12-32-28Z" fill="#fffdf5"/><path d="M600 294h128l-11 118c-1 9-9 16-18 16h-70c-9 0-17-7-18-16Z" fill="#c07845"/><ellipse cx="664" cy="294" rx="52" ry="14" fill="#4c2c22"/><path d="M744 322c40 0 44 58 0 58" stroke="#fffdf5" stroke-width="15" fill="none"/><path d="M624 246c-14-22 14-30 0-52M664 240c-14-22 14-30 0-52" stroke="#fffdf5" stroke-width="8" fill="none" stroke-linecap="round"/>`,
  bbq: `<g stroke="#4c2c22" stroke-width="14" stroke-linecap="round"><path d="M506 268l316 128"/><path d="M506 396l316-128"/></g><g fill="#c07845"><circle cx="560" cy="300" r="30"/><circle cx="626" cy="330" r="34"/><circle cx="700" cy="356" r="30"/><circle cx="754" cy="304" r="26"/></g><g fill="#6c8d43"><ellipse cx="534" cy="380" rx="28" ry="12" transform="rotate(-20 534 380)"/><ellipse cx="778" cy="388" rx="24" ry="10" transform="rotate(18 778 388)"/></g>`,
  sandwich: `<g><ellipse cx="660" cy="286" rx="120" ry="50" fill="#d99a4e"/><rect x="540" y="298" width="240" height="30" rx="15" fill="#7c9c4d"/><rect x="548" y="328" width="224" height="44" rx="18" fill="#5b2c27"/><rect x="540" y="372" width="240" height="26" rx="13" fill="#e8b45a"/><path d="M548 406c20 46 220 46 240 0Z" fill="#d99a4e"/></g>`,
};

function coverSvg(osmId: string, profile: MenuProfileKey): string {
  const colors = palettes[hashString(osmId) % palettes.length];
  const rotate = (hashString(osmId) % 9) - 4;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 800" role="img" aria-label="Hanoi restaurant illustration">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${colors[0]}"/><stop offset=".55" stop-color="${colors[1]}" stop-opacity=".38"/><stop offset="1" stop-color="#fffdf7"/>
    </linearGradient>
    <radialGradient id="glow" cx=".75" cy=".2" r=".7">
      <stop offset="0" stop-color="#ffffff" stop-opacity=".9"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="1200" height="800" fill="url(#bg)"/>
  <rect width="1200" height="800" fill="url(#glow)"/>
  <g opacity=".14" stroke="${colors[2]}" stroke-width="2" fill="none">
    <circle cx="930" cy="330" r="300"/><circle cx="930" cy="330" r="240"/><circle cx="930" cy="330" r="180"/>
  </g>
  <g transform="translate(0 ${rotate})">${coverMotifs[profile]}</g>
  <g stroke="${colors[2]}" stroke-width="6" opacity=".45" stroke-linecap="round">
    <path d="M104 250l250 250"/><path d="M128 224l250 250"/>
  </g>
  <g fill="#6c8d43" opacity=".75">${leaf(150, 610, -28, '#6c8d43')}${leaf(214, 640, 18, '#8cad5b')}${leaf(1080, 620, 24, '#6c8d43')}</g>
  <g fill="${colors[2]}">
    <text x="76" y="96" font-family="Georgia, serif" font-size="22" letter-spacing="8">BẾP · HÀ NỘI</text>
    <text x="76" y="676" font-family="Georgia, serif" font-size="48" letter-spacing="2">Hanoi kitchen</text>
    <text x="80" y="718" font-family="Arial, sans-serif" font-size="17" letter-spacing="4" opacity=".72">OPENSTREETMAP LOCATION · DEMO MENU · ILLUSTRATION</text>
  </g>
  <rect x="76" y="122" width="76" height="5" rx="3" fill="${colors[1]}"/>
</svg>`;
}

let written = 0;
for (const key of dishKeys) {
  writeFileSync(join(output, `dish-${key}.svg`), dishSvg(key));
  written++;
}
for (const restaurant of CURATED_HANOI_RESTAURANTS) {
  writeFileSync(
    join(output, `hanoi-${restaurant.osmId}.svg`),
    coverSvg(restaurant.osmId, restaurant.menuProfile),
  );
  written++;
}
console.log(`Wrote ${written} SVG illustrations to ${output}`);
console.log(
  `Dish keys: ${dishKeys.length}; restaurant covers: ${CURATED_HANOI_RESTAURANTS.length}`,
);
