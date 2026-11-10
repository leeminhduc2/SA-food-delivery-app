import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  CURATED_HANOI_RESTAURANTS,
  MENU_PROFILES,
  buildDemoMenu,
  coverImage,
  demoDescription,
  demoTags,
  deliveryFeeFor,
  etaFor,
  formatCuisine,
  sourceUrl,
  type MenuProfileKey,
} from '../server/modules/catalog/import/hanoi.js';
import { selectCuratedRestaurants } from '../server/services/hanoi-import.service.js';

const publicFile = (path: string) =>
  existsSync(join(process.cwd(), 'public', path.replace(/^\//, '')));

test('the curated list contains 30 unique real OSM nodes', () => {
  assert.equal(CURATED_HANOI_RESTAURANTS.length, 30);
  const keys = CURATED_HANOI_RESTAURANTS.map(
    (restaurant) => `${restaurant.osmType}/${restaurant.osmId}`,
  );
  assert.equal(new Set(keys).size, keys.length, 'duplicate OSM identities');
  for (const restaurant of CURATED_HANOI_RESTAURANTS) {
    assert.equal(restaurant.osmType, 'node');
    assert.match(restaurant.osmId, /^\d+$/);
    assert.ok(restaurant.expectedName.length > 2);
    assert.ok(restaurant.menuProfile in MENU_PROFILES);
  }
});

test('selectCuratedRestaurants accepts node/id and bare ids and rejects unknown keys', () => {
  assert.equal(selectCuratedRestaurants().length, 30);
  assert.equal(
    selectCuratedRestaurants(['node/3678370944'])[0].expectedName,
    'The Hanoi Social Club',
  );
  assert.equal(selectCuratedRestaurants(['3514125539'])[0].expectedName, 'Bánh Mì 25');
  assert.throws(() => selectCuratedRestaurants(['node/1']), /Unknown curated OSM key/);
});

test('every menu profile produces a deterministic 3/4/3 demo menu with valid images', () => {
  for (const [profileKey, profile] of Object.entries(MENU_PROFILES) as [
    MenuProfileKey,
    (typeof MENU_PROFILES)[MenuProfileKey],
  ][]) {
    assert.equal(profile.categories.length, 3, `${profileKey} category count`);
    const menu = buildDemoMenu('node', '721836715', profileKey);
    assert.equal(menu.itemCount, 10);
    assert.deepEqual(
      menu.categories.map((category) => category.items.length),
      [3, 4, 3],
    );
    assert.deepEqual(
      menu.categories.map((category) => category.name),
      profile.categories.map((category) => category.name),
    );
    const ids = menu.categories.flatMap((category) => category.items.map((item) => item.id));
    assert.equal(new Set(ids).size, 10);
    for (const item of menu.categories.flatMap((category) => category.items)) {
      assert.match(item.id, /^demo-node-721836715-\d+$/);
      assert.ok(Number.isInteger(item.price) && item.price >= 1000 && item.price <= 10_000_000);
      assert.ok(item.price % 1000 === 0);
      assert.equal(item.available, true);
      assert.equal(item.stock, 30);
      assert.deepEqual(item.options, []);
      assert.match(item.image, /^\/images\/dish-[a-z0-9-]+\.svg$/);
      assert.ok(publicFile(item.image), `missing ${item.image}`);
    }
    assert.deepEqual(buildDemoMenu('node', '721836715', profileKey), menu);
  }
});

test('each curated restaurant has a local cover and a distinct deterministic menu id space', () => {
  const menus = CURATED_HANOI_RESTAURANTS.map((restaurant) => {
    assert.ok(publicFile(coverImage(restaurant.osmId)), `missing ${coverImage(restaurant.osmId)}`);
    assert.ok([15000, 18000, 20000, 22000, 25000].includes(deliveryFeeFor(restaurant.osmId)));
    assert.ok([25, 30, 35, 40].includes(etaFor(restaurant.osmId)));
    return buildDemoMenu(restaurant.osmType, restaurant.osmId, restaurant.menuProfile);
  });
  const ids = menus.flatMap((menu) =>
    menu.categories.flatMap((category) => category.items.map((item) => item.id)),
  );
  assert.equal(ids.length, 300);
  assert.equal(new Set(ids).size, 300);
});

test('demo metadata marks menus as unofficial and records OSM provenance', () => {
  const menu = buildDemoMenu('node', '3678370944', 'cafe');
  const tags = demoTags('node', '3678370944', 'cafe', menu) as any;
  assert.equal(tags._bep.dataProvider, 'OpenStreetMap');
  assert.equal(tags._bep.license, 'ODbL-1.0');
  assert.equal(tags._bep.sourceUrl, 'https://www.openstreetmap.org/node/3678370944');
  assert.equal(sourceUrl('node', '3678370944'), tags._bep.sourceUrl);
  assert.equal(tags._bep.menu.dataType, 'DEMO');
  assert.equal(tags._bep.menu.official, false);
  assert.equal(tags._bep.menu.profile, 'cafe');
  assert.equal(tags._bep.menu.itemCount, 10);
  assert.match(tags._bep.menu.notice, /demo/i);
  assert.equal(tags._bep.image.type, 'ILLUSTRATION');
  assert.equal(tags._bep.image.license, 'Project demo asset');
  assert.match(demoDescription(), /demo data/i);
  assert.match(demoDescription(), /OpenStreetMap/);
});

test('cuisine labels are derived from OSM and never invented', () => {
  assert.equal(formatCuisine(null), 'Unclassified');
  assert.equal(formatCuisine('  '), 'Unclassified');
  assert.equal(formatCuisine('vietnamese'), 'Vietnamese');
  assert.equal(formatCuisine('vietnamese;asian'), 'Vietnamese, Asian');
  assert.equal(formatCuisine('noodle_soup;vietnamese'), 'Noodle Soup, Vietnamese');
  assert.equal(formatCuisine('a;b;c;d'), 'A, B, C');
});
