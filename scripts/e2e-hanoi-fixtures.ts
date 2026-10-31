/**
 * Deterministic Overpass response for browser tests.
 *
 * The values are the real OSM tags for the two selected nodes, so the E2E
 * suite exercises the same normalization and demo-menu path as the live
 * curated import without making a network request.
 */
export const HANOI_E2E_FIXTURES = [
  {
    type: 'node',
    id: 3678370944,
    lat: 21.0291515,
    lon: 105.8461905,
    tags: {
      'addr:district': 'Hoàn Kiếm',
      'addr:housenumber': '6',
      'addr:street': 'Ngõ Hội Vũ',
      amenity: 'cafe',
      cuisine: 'breakfast;burger;coffee_shop;tea',
      name: 'The Hanoi Social Club',
      opening_hours: '08:00-23:00',
      phone: '+84 24 3938 2117',
    },
  },
  {
    type: 'node',
    id: 3514125539,
    lat: 21.0360802,
    lon: 105.8486929,
    tags: {
      'addr:city': 'Hà Nội',
      'addr:district': 'Phường Hoàn Kiếm',
      'addr:housenumber': '25',
      'addr:street': 'Hàng Cá',
      amenity: 'fast_food',
      cuisine: 'sandwich',
      name: 'Bánh Mì 25',
      opening_hours: 'Mo-Sa 07:00-19:00, Su 07:00-17:00',
      phone: '+84977668895',
    },
  },
];

export const HANOI_E2E_IDS = ['node/3678370944', 'node/3514125539'];
