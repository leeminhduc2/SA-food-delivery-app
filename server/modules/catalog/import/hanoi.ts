/**
 * Curated Hanoi demo data.
 *
 * Restaurant identities come from OpenStreetMap. The importer always fetches
 * the current name/address/coordinates from Overpass; this module only selects
 * which OSM elements to import and describes the clearly-labelled demo menu
 * that is attached to them. Nothing here invents an address or coordinate.
 */

export type MenuProfileKey =
  | 'vietnamese'
  | 'japanese'
  | 'indian'
  | 'thai'
  | 'french'
  | 'international'
  | 'cafe'
  | 'bbq'
  | 'sandwich';

export type CuratedRestaurant = {
  osmType: 'node';
  osmId: string;
  expectedName: string;
  menuProfile: MenuProfileKey;
};

export type DishDefinition = {
  name: string;
  description: string;
  basePrice: number;
  imageKey: string;
};

export type MenuCategoryDefinition = {
  name: string;
  items: DishDefinition[];
};

export type MenuProfile = {
  label: string;
  categories: MenuCategoryDefinition[];
};

export type DemoMenuItem = {
  id: string;
  menuName: string;
  name: string;
  description: string;
  price: number;
  image: string;
  available: boolean;
  stock: number;
  options: never[];
};

export type DemoMenu = {
  categories: { name: string; items: DemoMenuItem[] }[];
  itemCount: number;
};

const dish = (
  name: string,
  description: string,
  basePrice: number,
  imageKey: string,
): DishDefinition => ({ name, description, basePrice, imageKey });

const category = (name: string, items: DishDefinition[]): MenuCategoryDefinition => ({
  name,
  items,
});

/**
 * Menu profiles are demo content, not official menus. They are selected by
 * cuisine/venue style and clearly marked in the database and UI.
 */
export const MENU_PROFILES: Record<MenuProfileKey, MenuProfile> = {
  vietnamese: {
    label: 'Vietnamese',
    categories: [
      category('Starters', [
        dish(
          'Gỏi cuốn tôm',
          'Fresh shrimp spring rolls with herbs and dipping sauce.',
          45000,
          'spring-rolls',
        ),
        dish('Nem rán Hà Nội', 'Crisp Hanoi-style fried spring rolls.', 55000, 'fried-rolls'),
        dish('Bánh mì pate', 'Mini baguette with pâté and pickled vegetables.', 35000, 'banh-mi'),
      ]),
      category('Main dishes', [
        dish('Phở bò Hà Nội', 'Hanoi beef noodle soup with fresh herbs.', 65000, 'pho'),
        dish(
          'Bún chả Hà Nội',
          'Grilled pork, noodles, herbs and warm dipping broth.',
          70000,
          'bun-cha',
        ),
        dish('Cơm rang dưa bò', 'Beef fried rice with pickled vegetables.', 65000, 'rice'),
        dish('Bún bò Nam Bộ', 'Beef noodle bowl with peanuts and herbs.', 70000, 'noodles'),
        dish('Chả cá Lã Vọng', 'Turmeric fish with dill, noodles and peanuts.', 120000, 'seafood'),
      ]),
      category('Drinks', [
        dish('Cà phê sữa đá', 'Vietnamese iced coffee with condensed milk.', 30000, 'coffee'),
        dish('Trà đá', 'Light iced tea.', 10000, 'tea'),
        dish('Nước chanh', 'Fresh lime juice.', 25000, 'drink'),
        dish('Sinh tố xoài', 'Mango smoothie.', 40000, 'smoothie'),
      ]),
    ],
  },
  japanese: {
    label: 'Japanese',
    categories: [
      category('Starters', [
        dish('Edamame', 'Steamed soy beans with sea salt.', 45000, 'salad'),
        dish('Gyoza', 'Pan-fried pork dumplings.', 65000, 'fried-rolls'),
        dish('Miso soup', 'Warm soybean soup with tofu and seaweed.', 35000, 'soup'),
      ]),
      category('Main dishes', [
        dish('Sushi set', 'Assorted nigiri and maki selection.', 220000, 'sushi'),
        dish('Salmon sashimi', 'Sliced salmon with wasabi and soy.', 180000, 'seafood'),
        dish('Chicken teriyaki', 'Grilled chicken with teriyaki glaze.', 120000, 'grill'),
        dish('Ramen', 'Noodle soup with pork, egg and spring onion.', 110000, 'ramen'),
        dish('Tempura', 'Lightly battered prawns and vegetables.', 150000, 'tempura'),
      ]),
      category('Drinks', [
        dish('Green tea', 'Hot Japanese green tea.', 25000, 'tea'),
        dish('Matcha latte', 'Matcha with milk.', 45000, 'coffee'),
        dish('Yuzu soda', 'Sparkling citrus soda.', 40000, 'drink'),
        dish('Ramune', 'Japanese marble soda.', 40000, 'drink'),
      ]),
    ],
  },
  indian: {
    label: 'Indian',
    categories: [
      category('Starters', [
        dish('Samosa', 'Crisp pastry with spiced potato filling.', 45000, 'fried-rolls'),
        dish('Onion bhaji', 'Fried onion fritters.', 50000, 'fried-rolls'),
        dish('Chicken tikka', 'Yoghurt-marinated grilled chicken.', 110000, 'grill'),
      ]),
      category('Main dishes', [
        dish('Butter chicken', 'Creamy tomato chicken curry.', 150000, 'curry'),
        dish('Lamb rogan josh', 'Slow-cooked lamb curry with spices.', 180000, 'curry'),
        dish('Palak paneer', 'Spinach curry with paneer.', 130000, 'curry'),
        dish('Dal tadka', 'Yellow lentils with tempered spices.', 95000, 'curry'),
        dish('Biryani', 'Fragrant rice with spices and herbs.', 140000, 'rice'),
        dish('Garlic naan', 'Tandoor-baked flatbread with garlic.', 35000, 'bread'),
      ]),
      category('Drinks', [
        dish('Masala chai', 'Spiced milk tea.', 30000, 'tea'),
        dish('Mango lassi', 'Yoghurt drink with mango.', 45000, 'smoothie'),
        dish('Lime soda', 'Fresh lime with soda.', 35000, 'drink'),
        dish('Salted lassi', 'Savoury yoghurt drink.', 40000, 'smoothie'),
      ]),
    ],
  },
  thai: {
    label: 'Thai',
    categories: [
      category('Starters', [
        dish('Thai spring rolls', 'Crisp rolls with sweet chilli sauce.', 55000, 'spring-rolls'),
        dish('Chicken satay', 'Grilled skewers with peanut sauce.', 75000, 'grill'),
        dish('Tom yum soup', 'Hot and sour soup with prawns.', 85000, 'soup'),
      ]),
      category('Main dishes', [
        dish('Pad Thai', 'Rice noodles with tamarind, egg and peanuts.', 95000, 'pad-thai'),
        dish('Green curry', 'Coconut curry with chicken and basil.', 120000, 'curry'),
        dish('Massaman curry', 'Mild coconut curry with potato.', 130000, 'curry'),
        dish('Khao pad', 'Thai fried rice with vegetables.', 90000, 'rice'),
        dish('Basil chicken', 'Stir-fried chicken with holy basil.', 105000, 'grill'),
      ]),
      category('Drinks', [
        dish('Thai iced tea', 'Sweet spiced tea with milk.', 35000, 'tea'),
        dish('Coconut water', 'Chilled coconut water.', 45000, 'drink'),
        dish('Lime soda', 'Fresh lime with soda.', 35000, 'drink'),
        dish('Thai iced coffee', 'Sweet iced coffee with milk.', 40000, 'coffee'),
      ]),
    ],
  },
  french: {
    label: 'French',
    categories: [
      category('Starters', [
        dish('French onion soup', 'Caramelised onion soup with croutons.', 95000, 'soup'),
        dish('Goat cheese salad', 'Warm goat cheese with garden greens.', 110000, 'salad'),
        dish('Chicken pâté', 'Country pâté with toasted bread.', 120000, 'bread'),
      ]),
      category('Main dishes', [
        dish('Steak frites', 'Grilled steak with fries.', 260000, 'steak'),
        dish('Coq au vin', 'Chicken braised in red wine.', 240000, 'grill'),
        dish('Duck confit', 'Slow-cooked duck with crisp skin.', 280000, 'steak'),
        dish('Ratatouille', 'Summer vegetables cooked in olive oil.', 160000, 'salad'),
        dish('Moules marinières', 'Mussels in white wine and herbs.', 210000, 'seafood'),
      ]),
      category('Drinks', [
        dish('House red', 'Glass of house red wine.', 90000, 'drink'),
        dish('Sparkling water', 'Chilled sparkling water.', 30000, 'drink'),
        dish('Espresso', 'Short espresso.', 30000, 'coffee'),
        dish('Lemon tart', 'Tangy lemon tart.', 60000, 'dessert'),
      ]),
    ],
  },
  international: {
    label: 'International',
    categories: [
      category('Starters', [
        dish('Bruschetta', 'Tomato and basil on toasted bread.', 65000, 'bread'),
        dish('Chicken wings', 'Crisp wings with a house sauce.', 85000, 'grill'),
        dish('Caesar salad', 'Cos lettuce, parmesan and croutons.', 95000, 'salad'),
      ]),
      category('Main dishes', [
        dish('Beef burger', 'Beef patty, cheese and pickles.', 150000, 'burger'),
        dish('Fish and chips', 'Battered fish with fries.', 160000, 'seafood'),
        dish('Margherita pizza', 'Tomato, mozzarella and basil.', 140000, 'pizza'),
        dish('Pasta carbonara', 'Pasta with egg, cheese and pepper.', 150000, 'pasta'),
        dish('Grilled chicken', 'Herb-grilled chicken with vegetables.', 170000, 'grill'),
      ]),
      category('Drinks', [
        dish('Iced tea', 'Chilled black tea.', 30000, 'tea'),
        dish('Lemonade', 'Fresh lemonade.', 35000, 'drink'),
        dish('Craft soda', 'House-made fruit soda.', 40000, 'drink'),
        dish('Brownie', 'Warm chocolate brownie.', 55000, 'dessert'),
      ]),
    ],
  },
  cafe: {
    label: 'Café',
    categories: [
      category('Starters', [
        dish('Banana bread', 'Toasted banana bread with butter.', 45000, 'bread'),
        dish('Butter croissant', 'Flaky butter croissant.', 35000, 'bread'),
        dish('Yoghurt granola', 'Yoghurt with granola and fruit.', 55000, 'dessert'),
      ]),
      category('Main dishes', [
        dish('Eggs Benedict', 'Poached eggs, ham and hollandaise.', 110000, 'breakfast'),
        dish('Big breakfast', 'Eggs, toast, tomato and sausage.', 150000, 'breakfast'),
        dish('Avocado toast', 'Smashed avocado on sourdough.', 85000, 'bread'),
        dish('Club sandwich', 'Triple-decker sandwich with fries.', 105000, 'sandwich'),
        dish('Pancakes', 'Stack of pancakes with syrup.', 90000, 'dessert'),
      ]),
      category('Drinks', [
        dish('Flat white', 'Espresso with steamed milk.', 45000, 'coffee'),
        dish('Cold brew', 'Slow-steeped iced coffee.', 45000, 'coffee'),
        dish('Matcha latte', 'Matcha with milk.', 50000, 'coffee'),
        dish('Fresh orange', 'Freshly squeezed orange juice.', 40000, 'drink'),
      ]),
    ],
  },
  bbq: {
    label: 'Grill & BBQ',
    categories: [
      category('Starters', [
        dish('Kimchi', 'Spicy fermented cabbage.', 35000, 'salad'),
        dish('Edamame', 'Steamed soy beans with sea salt.', 40000, 'salad'),
        dish('Spicy cucumber', 'Chilled cucumber with chilli.', 35000, 'salad'),
      ]),
      category('Main dishes', [
        dish('Beef brisket', 'Slow-smoked beef brisket.', 180000, 'grill'),
        dish('Pork belly', 'Grilled pork belly slices.', 160000, 'grill'),
        dish('Chicken thigh', 'Marinated grilled chicken.', 120000, 'grill'),
        dish('Short ribs', 'Grilled marinated short ribs.', 220000, 'grill'),
        dish('Grilled prawns', 'Charred prawns with citrus.', 190000, 'seafood'),
        dish('Vegetable skewers', 'Grilled seasonal vegetables.', 90000, 'grill'),
      ]),
      category('Drinks', [
        dish('Draft beer', 'Chilled local draft beer.', 35000, 'drink'),
        dish('Soft drink', 'Chilled soft drink.', 25000, 'drink'),
        dish('Iced tea', 'Light iced tea.', 25000, 'tea'),
        dish('Barley tea', 'Roasted barley tea.', 25000, 'tea'),
      ]),
    ],
  },
  sandwich: {
    label: 'Bánh mì & sandwiches',
    categories: [
      category('Starters', [
        dish('Mini spring roll', 'Small crisp spring roll.', 35000, 'spring-rolls'),
        dish('Chicken wings', 'Crisp wings with a house sauce.', 70000, 'grill'),
        dish('Fresh salad', 'Garden greens with herbs.', 45000, 'salad'),
      ]),
      category('Main dishes', [
        dish('Bánh mì thịt nướng', 'Grilled pork baguette with pickles.', 45000, 'banh-mi'),
        dish('Bánh mì gà', 'Chicken baguette with herbs.', 45000, 'banh-mi'),
        dish('Bánh mì trứng', 'Egg baguette with chilli and herbs.', 35000, 'banh-mi'),
        dish('Bánh mì chả cá', 'Fish cake baguette with dill.', 50000, 'banh-mi'),
        dish('Bánh mì bò', 'Beef baguette with pickled vegetables.', 55000, 'banh-mi'),
      ]),
      category('Drinks', [
        dish('Vietnamese iced coffee', 'Coffee with condensed milk.', 30000, 'coffee'),
        dish('Herbal tea', 'Light herbal infusion.', 25000, 'tea'),
        dish('Fresh lime', 'Fresh lime juice.', 30000, 'drink'),
        dish('Soy milk', 'Chilled soy milk.', 25000, 'drink'),
      ]),
    ],
  },
};

/**
 * 30 real Hanoi establishments selected from an Overpass result for central
 * Hanoi. `expectedName` is a drift check only: the imported name always comes
 * from the live OSM response.
 */
export const CURATED_HANOI_RESTAURANTS: CuratedRestaurant[] = [
  {
    osmType: 'node',
    osmId: '104770283',
    expectedName: 'Cửa Hàng Bò Nầm Nướng',
    menuProfile: 'bbq',
  },
  {
    osmType: 'node',
    osmId: '721788305',
    expectedName: 'Nhà Hàng Little Hanoi',
    menuProfile: 'vietnamese',
  },
  {
    osmType: 'node',
    osmId: '721788307',
    expectedName: 'Nhà Hàng New Day',
    menuProfile: 'vietnamese',
  },
  {
    osmType: 'node',
    osmId: '721836715',
    expectedName: 'Quán Ăn Ngon - Phan Bội Châu',
    menuProfile: 'vietnamese',
  },
  {
    osmType: 'node',
    osmId: '721906714',
    expectedName: 'Sushi Hokkaido Sachi',
    menuProfile: 'japanese',
  },
  {
    osmType: 'node',
    osmId: '721906721',
    expectedName: 'Tandoor Indian Cuisine',
    menuProfile: 'indian',
  },
  {
    osmType: 'node',
    osmId: '723684563',
    expectedName: 'Nhà Hàng La Badiane',
    menuProfile: 'french',
  },
  { osmType: 'node', osmId: '773601261', expectedName: 'Pho 10', menuProfile: 'vietnamese' },
  { osmType: 'node', osmId: '963611886', expectedName: 'Thai Village', menuProfile: 'thai' },
  { osmType: 'node', osmId: '975757197', expectedName: 'Toshi Fusion', menuProfile: 'japanese' },
  {
    osmType: 'node',
    osmId: '977647355',
    expectedName: 'Nhà Hàng Duy Lê Malraux',
    menuProfile: 'french',
  },
  {
    osmType: 'node',
    osmId: '993037617',
    expectedName: 'Nhà Hàng Yakiniku Shiki',
    menuProfile: 'bbq',
  },
  {
    osmType: 'node',
    osmId: '998227583',
    expectedName: 'Nhà Hàng Green Mango',
    menuProfile: 'international',
  },
  {
    osmType: 'node',
    osmId: '1000087449',
    expectedName: 'Nhà Hàng Chả Cá Văn Miếu',
    menuProfile: 'vietnamese',
  },
  {
    osmType: 'node',
    osmId: '1671744985',
    expectedName: 'Nhà Hàng Chả Cá Thủy Hồng',
    menuProfile: 'vietnamese',
  },
  {
    osmType: 'node',
    osmId: '2256217990',
    expectedName: 'Nhà Hàng Blue Butterfly',
    menuProfile: 'international',
  },
  {
    osmType: 'node',
    osmId: '2256217991',
    expectedName: 'Nhà Hàng Essence',
    menuProfile: 'vietnamese',
  },
  {
    osmType: 'node',
    osmId: '2259067320',
    expectedName: 'Chả Cá Cà Cuống',
    menuProfile: 'vietnamese',
  },
  { osmType: 'node', osmId: '2587491495', expectedName: 'Phở Cường', menuProfile: 'vietnamese' },
  {
    osmType: 'node',
    osmId: '3370369424',
    expectedName: 'Nhà Hàng Wa Japanese Cuisine',
    menuProfile: 'japanese',
  },
  {
    osmType: 'node',
    osmId: '3496458225',
    expectedName: 'Nhà Hàng Foodshop 45',
    menuProfile: 'indian',
  },
  {
    osmType: 'node',
    osmId: '3496464405',
    expectedName: 'Quán Cơm Mậu Dịch',
    menuProfile: 'vietnamese',
  },
  { osmType: 'node', osmId: '3496893646', expectedName: 'Quan An Ngon', menuProfile: 'vietnamese' },
  { osmType: 'node', osmId: '3514125539', expectedName: 'Bánh Mì 25', menuProfile: 'sandwich' },
  {
    osmType: 'node',
    osmId: '3671198536',
    expectedName: 'Nhà Hàng Moto-san',
    menuProfile: 'japanese',
  },
  {
    osmType: 'node',
    osmId: '3678370944',
    expectedName: 'The Hanoi Social Club',
    menuProfile: 'cafe',
  },
  {
    osmType: 'node',
    osmId: '4151407589',
    expectedName: 'Bún Chẳ Đắc Kim',
    menuProfile: 'vietnamese',
  },
  { osmType: 'node', osmId: '4186819465', expectedName: 'Pho Thin', menuProfile: 'vietnamese' },
  { osmType: 'node', osmId: '4210706604', expectedName: 'Xoi Yen', menuProfile: 'vietnamese' },
  {
    osmType: 'node',
    osmId: '4272727197',
    expectedName: 'Cửa Hàng Bún Chả Hương Liên',
    menuProfile: 'vietnamese',
  },
];

export const CURATED_BY_KEY = new Map(
  CURATED_HANOI_RESTAURANTS.map((restaurant) => [
    `${restaurant.osmType}/${restaurant.osmId}`,
    restaurant,
  ]),
);

export function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** OSM stores `cuisine` as a lowercase semicolon list. */
export function formatCuisine(raw: string | null): string {
  if (!raw) return 'Unclassified';
  const parts = raw
    .split(';')
    .map((part) => part.trim().replaceAll('_', ' '))
    .filter(Boolean)
    .slice(0, 3);
  if (!parts.length) return 'Unclassified';
  return parts.map((part) => part.replace(/\b[a-z]/g, (letter) => letter.toUpperCase())).join(', ');
}

function adjustPrice(basePrice: number, seed: number): number {
  const percent = (seed % 9) - 4;
  const adjusted = Math.round((basePrice * (100 + percent)) / 100 / 1000) * 1000;
  return Math.max(1000, Math.min(10000000, adjusted));
}

export function buildDemoMenu(
  osmType: string,
  osmId: string,
  profileKey: MenuProfileKey,
): DemoMenu {
  const profile = MENU_PROFILES[profileKey];
  const seed = hashString(`${osmType}/${osmId}`);
  const perCategory = [3, 4, 3];
  let itemIndex = 0;
  const categories = profile.categories.map((categoryDefinition, categoryIndex) => {
    const take = Math.min(perCategory[categoryIndex] ?? 3, categoryDefinition.items.length);
    const start = (seed + categoryIndex * 7) % categoryDefinition.items.length;
    const items = Array.from({ length: take }, (_, offset) => {
      const definition =
        categoryDefinition.items[(start + offset) % categoryDefinition.items.length];
      itemIndex++;
      return {
        id: `demo-${osmType}-${osmId}-${itemIndex}`,
        menuName: categoryDefinition.name,
        name: definition.name,
        description: definition.description,
        price: adjustPrice(definition.basePrice, seed + itemIndex * 17),
        image: `/images/dish-${definition.imageKey}.svg`,
        available: true,
        stock: 30,
        options: [] as never[],
      };
    });
    return { name: categoryDefinition.name, items };
  });
  return { categories, itemCount: itemIndex };
}

export function coverImage(osmId: string): string {
  return `/images/hanoi-${osmId}.svg`;
}

export function deliveryFeeFor(osmId: string): number {
  const fees = [15000, 18000, 20000, 22000, 25000];
  return fees[hashString(osmId) % fees.length];
}

export function etaFor(osmId: string): number {
  return 25 + (hashString(osmId) % 4) * 5;
}

export function sourceUrl(osmType: string, osmId: string): string {
  return `https://www.openstreetmap.org/${osmType}/${osmId}`;
}

export function demoDescription(): string {
  return 'Hanoi venue imported from OpenStreetMap (ODbL). Location data is unverified; the menu shown is demo data, not the restaurant’s official menu.';
}

export function demoTags(
  osmType: string,
  osmId: string,
  profileKey: MenuProfileKey,
  menu: DemoMenu,
): Record<string, unknown> {
  return {
    _bep: {
      schema: 1,
      dataProvider: 'OpenStreetMap',
      sourceUrl: sourceUrl(osmType, osmId),
      license: 'ODbL-1.0',
      attribution: '© OpenStreetMap contributors',
      importedBy: 'bep-hanoi-demo-import/1.0',
      menu: {
        dataType: 'DEMO',
        official: false,
        profile: profileKey,
        itemCount: menu.itemCount,
        notice: 'Demo dishes and prices; not the restaurant’s official menu.',
      },
      image: {
        type: 'ILLUSTRATION',
        license: 'Project demo asset',
        source: coverImage(osmId),
        note: 'Illustration, not a photograph of the venue.',
      },
    },
  };
}
