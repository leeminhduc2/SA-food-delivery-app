/**
 * Fictional demo catalog for the Bếp application.
 *
 * Every restaurant, address, phone number, rating and dish here is invented for
 * development, testing and demonstrations. None of it describes a real
 * business, and no value may be presented as verified business data.
 *
 * The catalog deliberately stores local image paths for raster food photography
 * (`webp`). The images are produced separately; when a file is missing the UI
 * shows an explicit "photo pending" placeholder instead of a fake illustration.
 */

export const MOCK_SOURCE = 'MOCK';
export const MOCK_MENU_NOTE =
  'Fictional demo catalog. Restaurants, addresses, prices and ratings are invented for development and are not verified business data.';

export type MockMenuItem = {
  id: string;
  name: string;
  description: string;
  price: number;
  category: string;
  available: boolean;
  stock: number;
};

export type MockRestaurant = {
  id: string;
  slug: string;
  name: string;
  description: string;
  cuisine: string;
  district: string;
  address: string;
  latitude: number;
  longitude: number;
  phone: string;
  opening_hours: string;
  delivery_fee: number;
  eta_minutes: number;
  rating: number;
  review_count: number;
  menus: { key: string; name: string; items: MockMenuItem[] }[];
};

export function restaurantImage(slug: string): string {
  return `/images/restaurants/${slug}.webp`;
}

export function itemImage(itemId: string): string {
  return `/images/menu-items/${itemId}.webp`;
}

function item(
  id: string,
  name: string,
  description: string,
  price: number,
  category: string,
): MockMenuItem {
  return { id, name, description, price, category, available: true, stock: 30 };
}

export const MOCK_RESTAURANTS: MockRestaurant[] = [
  {
    id: 'mock-restaurant-01',
    slug: 'bep-pho-ha-thanh',
    name: 'Bếp Phố Hà Thành',
    description:
      'Quán phở gia đình trong phố cổ, nước dùng ninh xương bò nhiều giờ và bánh phở tráng tay mỗi sáng.',
    cuisine: 'Vietnamese',
    district: 'Hoàn Kiếm',
    address: '18 Phố Hàng Bạc, Hoàn Kiếm, Hà Nội',
    latitude: 21.0301,
    longitude: 105.8527,
    phone: '+84 24 5555 0101',
    opening_hours: '07:00–22:00',
    delivery_fee: 15000,
    eta_minutes: 25,
    rating: 4.8,
    review_count: 512,
    menus: [
      {
        key: 'main',
        name: 'Món chính',
        items: [
          item(
            'mock-item-001',
            'Phở bò tái',
            'Bánh phở mềm, thịt bò tái mỏng, nước dùng xương bò trong và thơm quế hồi.',
            55000,
            'Món chính',
          ),
          item(
            'mock-item-002',
            'Phở bò đặc biệt',
            'Đầy đủ bắp bò, gầu, nạm và thịt tái, ăn kèm hành lá và rau thơm.',
            75000,
            'Món chính',
          ),
          item(
            'mock-item-003',
            'Bún riêu cua',
            'Riêu cua đồng nấu cà chua, đậu phụ rán và bún sợi nhỏ.',
            45000,
            'Món chính',
          ),
          item(
            'mock-item-004',
            'Cơm rang dưa bò',
            'Cơm rang tơi cùng dưa chua, thịt bò xào và hành phi.',
            60000,
            'Món chính',
          ),
          item(
            'mock-item-005',
            'Bún bò Nam Bộ',
            'Bún trộn thịt bò xào, rau sống, đậu phộng rang và nước mắm chua ngọt.',
            50000,
            'Món chính',
          ),
        ],
      },
      {
        key: 'starters',
        name: 'Món khai vị',
        items: [
          item(
            'mock-item-006',
            'Nem rán',
            'Nem cuốn nhân thịt, miến và mộc nhĩ, rán giòn, dùng kèm nước chấm.',
            35000,
            'Món khai vị',
          ),
        ],
      },
    ],
  },
  {
    id: 'mock-restaurant-02',
    slug: 'goc-bun-cha',
    name: 'Góc Bún Chả',
    description: 'Bún chả than hoa đúng vị Hà Nội, thịt nướng thơm và nước chấm pha cân bằng.',
    cuisine: 'Vietnamese',
    district: 'Hai Bà Trưng',
    address: '42 Phố Lò Đúc, Hai Bà Trưng, Hà Nội',
    latitude: 21.0123,
    longitude: 105.8551,
    phone: '+84 24 5555 0102',
    opening_hours: '10:00–21:30',
    delivery_fee: 15000,
    eta_minutes: 20,
    rating: 4.6,
    review_count: 348,
    menus: [
      {
        key: 'main',
        name: 'Bún chả',
        items: [
          item(
            'mock-item-007',
            'Bún chả truyền thống',
            'Chả viên và chả miếng nướng than, bún tươi, rau sống và nước chấm.',
            50000,
            'Bún chả',
          ),
          item(
            'mock-item-008',
            'Bún chả đặc biệt',
            'Phần chả đầy đủ gồm chả viên, chả miếng và thêm thịt ba chỉ nướng.',
            65000,
            'Bún chả',
          ),
          item(
            'mock-item-012',
            'Bún chả thêm thịt',
            'Suất bún chả lớn với phần thịt nướng tăng thêm cho người ăn khỏe.',
            70000,
            'Bún chả',
          ),
        ],
      },
      {
        key: 'extras',
        name: 'Món thêm',
        items: [
          item(
            'mock-item-009',
            'Nem cua bể',
            'Nem cuốn cua bể và thịt, vỏ giòn, chấm nước mắm ớt.',
            45000,
            'Món thêm',
          ),
          item(
            'mock-item-010',
            'Nem rán',
            'Nem thịt truyền thống rán vàng đều, ăn kèm rau sống.',
            30000,
            'Món thêm',
          ),
          item(
            'mock-item-011',
            'Chả lá lốt',
            'Thịt băm cuốn lá lốt nướng, thơm mùi lá và tiêu.',
            40000,
            'Món thêm',
          ),
        ],
      },
    ],
  },
  {
    id: 'mock-restaurant-03',
    slug: 'nha-minh-kitchen',
    name: 'Nhà Mình Kitchen',
    description:
      'Cơm nhà nấu theo kiểu gia đình miền Bắc, thực đơn đổi theo ngày và luôn có canh nóng.',
    cuisine: 'Vietnamese',
    district: 'Đống Đa',
    address: '7 Ngõ 95 Chùa Bộc, Đống Đa, Hà Nội',
    latitude: 21.0127,
    longitude: 105.8297,
    phone: '+84 24 5555 0103',
    opening_hours: '10:30–21:00',
    delivery_fee: 18000,
    eta_minutes: 30,
    rating: 4.7,
    review_count: 221,
    menus: [
      {
        key: 'main',
        name: 'Cơm nhà',
        items: [
          item(
            'mock-item-013',
            'Cơm sườn nướng',
            'Sườn heo ướp mật ong nướng, cơm trắng, dưa chua và nước mắm.',
            55000,
            'Cơm nhà',
          ),
          item(
            'mock-item-014',
            'Cơm thịt kho trứng',
            'Thịt ba chỉ kho nước dừa cùng trứng vịt, đậm đà kiểu nhà làm.',
            50000,
            'Cơm nhà',
          ),
          item(
            'mock-item-015',
            'Cơm gà chiên mắm',
            'Đùi gà chiên sốt mắm tỏi, cơm trắng và rau luộc.',
            55000,
            'Cơm nhà',
          ),
          item(
            'mock-item-016',
            'Cá kho tộ',
            'Cá basa kho tộ đậm vị nước mắm, tiêu và ớt, ăn cùng cơm nóng.',
            65000,
            'Cơm nhà',
          ),
        ],
      },
      {
        key: 'sides',
        name: 'Canh & rau',
        items: [
          item(
            'mock-item-017',
            'Canh chua cá',
            'Canh chua cá basa với cà chua, dứa và rau thơm, vị chua thanh.',
            35000,
            'Canh & rau',
          ),
          item(
            'mock-item-018',
            'Rau muống xào tỏi',
            'Rau muống xào lửa lớn với tỏi, giữ độ giòn và xanh.',
            25000,
            'Canh & rau',
          ),
        ],
      },
    ],
  },
  {
    id: 'mock-restaurant-04',
    slug: 'lau-nha-go',
    name: 'Lẩu Nhà Gỗ',
    description: 'Không gian ấm cúng với lẩu nấm, lẩu bò và hải sản tươi, nước dùng nấu mỗi ngày.',
    cuisine: 'Hotpot',
    district: 'Cầu Giấy',
    address: '25 Phố Trần Duy Hưng, Cầu Giấy, Hà Nội',
    latitude: 21.026,
    longitude: 105.8006,
    phone: '+84 24 5555 0104',
    opening_hours: '11:00–22:30',
    delivery_fee: 25000,
    eta_minutes: 40,
    rating: 4.5,
    review_count: 189,
    menus: [
      {
        key: 'hotpot',
        name: 'Lẩu',
        items: [
          item(
            'mock-item-019',
            'Lẩu Thái hải sản',
            'Nước lẩu chua cay kiểu Thái, tôm, mực, nghêu và rau nhúng.',
            299000,
            'Lẩu',
          ),
          item(
            'mock-item-020',
            'Lẩu bò',
            'Nước dùng xương bò, thịt bò thái mỏng, nấm và rau tươi.',
            279000,
            'Lẩu',
          ),
          item(
            'mock-item-021',
            'Lẩu nấm',
            'Nước lẩu thanh từ nấm hương, nấm kim châm, đậu phụ và rau củ.',
            239000,
            'Lẩu',
          ),
        ],
      },
      {
        key: 'dips',
        name: 'Món nhúng',
        items: [
          item(
            'mock-item-022',
            'Ba chỉ bò Mỹ',
            'Ba chỉ bò thái mỏng, vân mỡ đều, dùng để nhúng lẩu.',
            129000,
            'Món nhúng',
          ),
          item(
            'mock-item-023',
            'Đĩa hải sản tổng hợp',
            'Tôm, mực, nghêu và cá viên chuẩn bị sẵn cho một nồi lẩu.',
            159000,
            'Món nhúng',
          ),
          item(
            'mock-item-024',
            'Rau và nấm tổng hợp',
            'Đĩa rau xanh, cải thảo, nấm kim châm và nấm hương.',
            49000,
            'Món nhúng',
          ),
        ],
      },
    ],
  },
  {
    id: 'mock-restaurant-05',
    slug: 'tiem-pizza-moc',
    name: 'Tiệm Pizza Mộc',
    description: 'Pizza đế mỏng nướng trong lò đá, nguyên liệu đơn giản và mì Ý nấu theo yêu cầu.',
    cuisine: 'Pizza',
    district: 'Ba Đình',
    address: '11 Phố Đội Cấn, Ba Đình, Hà Nội',
    latitude: 21.0357,
    longitude: 105.8266,
    phone: '+84 24 5555 0105',
    opening_hours: '11:00–22:00',
    delivery_fee: 20000,
    eta_minutes: 35,
    rating: 4.6,
    review_count: 276,
    menus: [
      {
        key: 'pizza',
        name: 'Pizza',
        items: [
          item(
            'mock-item-025',
            'Pizza Margherita',
            'Sốt cà chua, phô mai mozzarella và lá húng quế tươi trên đế mỏng.',
            129000,
            'Pizza',
          ),
          item(
            'mock-item-026',
            'Pizza bò BBQ',
            'Thịt bò nướng sốt BBQ, hành tây và phô mai cheddar.',
            169000,
            'Pizza',
          ),
          item(
            'mock-item-027',
            'Pizza hải sản',
            'Tôm, mực và cá ngừ cùng sốt cà chua và phô mai.',
            179000,
            'Pizza',
          ),
          item(
            'mock-item-028',
            'Pizza phô mai',
            'Bốn loại phô mai tan chảy trên nền sốt kem nhẹ.',
            159000,
            'Pizza',
          ),
        ],
      },
      {
        key: 'pasta',
        name: 'Mì Ý',
        items: [
          item(
            'mock-item-029',
            'Mì Ý bò bằm',
            'Spaghetti sốt bò bằm cà chua, rắc phô mai parmesan.',
            89000,
            'Mì Ý',
          ),
          item(
            'mock-item-030',
            'Mì Ý sốt kem',
            'Fettuccine sốt kem nấm, bơ và tiêu đen.',
            99000,
            'Mì Ý',
          ),
        ],
      },
    ],
  },
  {
    id: 'mock-restaurant-06',
    slug: 'sushi-mori',
    name: 'Sushi Mori',
    description: 'Quầy sushi nhỏ với cá hồi nhập mỗi ngày, cơm trộn giấm và wasabi tươi.',
    cuisine: 'Japanese',
    district: 'Hoàn Kiếm',
    address: '3 Phố Lý Thái Tổ, Hoàn Kiếm, Hà Nội',
    latitude: 21.0271,
    longitude: 105.8566,
    phone: '+84 24 5555 0106',
    opening_hours: '11:30–22:00',
    delivery_fee: 22000,
    eta_minutes: 35,
    rating: 4.7,
    review_count: 402,
    menus: [
      {
        key: 'sushi',
        name: 'Sushi & Sashimi',
        items: [
          item(
            'mock-item-031',
            'Sushi cá hồi',
            'Sáu cuộn sushi cá hồi tươi trên cơm trộn giấm.',
            89000,
            'Sushi & Sashimi',
          ),
          item(
            'mock-item-032',
            'Sashimi cá hồi',
            'Cá hồi thái lát dày, dùng kèm wasabi, gừng và nước tương.',
            129000,
            'Sushi & Sashimi',
          ),
          item(
            'mock-item-033',
            'Sushi tổng hợp',
            'Mười hai cuộn sushi gồm cá hồi, cá ngừ, tôm và trứng.',
            149000,
            'Sushi & Sashimi',
          ),
        ],
      },
      {
        key: 'hot',
        name: 'Món nóng',
        items: [
          item(
            'mock-item-034',
            'Tempura tôm',
            'Tôm tươi chiên tempura giòn, chấm sốt tentsuyu.',
            79000,
            'Món nóng',
          ),
          item(
            'mock-item-035',
            'Udon bò',
            'Mì udon nước dùng dashi, thịt bò thái mỏng và hành lá.',
            99000,
            'Món nóng',
          ),
          item(
            'mock-item-036',
            'Bento cá hồi',
            'Cơm, cá hồi nướng, salad và trứng cuộn trong hộp bento.',
            139000,
            'Món nóng',
          ),
        ],
      },
    ],
  },
  {
    id: 'mock-restaurant-07',
    slug: 'bep-thai-bangkok',
    name: 'Bếp Thái Bangkok',
    description: 'Món Thái cân bằng chua, cay, ngọt; nước cốt dừa và gia vị được nấu tại bếp.',
    cuisine: 'Thai',
    district: 'Thanh Xuân',
    address: '88 Phố Nguyễn Trãi, Thanh Xuân, Hà Nội',
    latitude: 20.9939,
    longitude: 105.8128,
    phone: '+84 24 5555 0107',
    opening_hours: '10:30–22:00',
    delivery_fee: 20000,
    eta_minutes: 35,
    rating: 4.4,
    review_count: 167,
    menus: [
      {
        key: 'main',
        name: 'Món chính',
        items: [
          item(
            'mock-item-037',
            'Pad Thai',
            'Mì gạo xào me, tôm, trứng và đậu phộng rang.',
            89000,
            'Món chính',
          ),
          item(
            'mock-item-038',
            'Tom Yum hải sản',
            'Canh Tom Yum chua cay với tôm, mực và nấm rơm.',
            119000,
            'Món chính',
          ),
          item(
            'mock-item-039',
            'Cơm cà ri Thái',
            'Cà ri đỏ nước cốt dừa với thịt gà và rau củ, dùng cùng cơm.',
            85000,
            'Món chính',
          ),
        ],
      },
      {
        key: 'extras',
        name: 'Khai vị & tráng miệng',
        items: [
          item(
            'mock-item-040',
            'Gỏi xoài Thái',
            'Xoài xanh bào sợi, đậu phộng, ớt và nước mắm chua ngọt.',
            55000,
            'Khai vị & tráng miệng',
          ),
          item(
            'mock-item-041',
            'Gà nướng Thái',
            'Gà ướp sả và gia vị Thái, nướng vàng, chấm sốt cay.',
            109000,
            'Khai vị & tráng miệng',
          ),
          item(
            'mock-item-042',
            'Xôi xoài',
            'Xôi nếp dẻo, xoài chín và nước cốt dừa rưới lên trên.',
            49000,
            'Khai vị & tráng miệng',
          ),
        ],
      },
    ],
  },
  {
    id: 'mock-restaurant-08',
    slug: 'mi-cay-seoul',
    name: 'Mì Cay Seoul',
    description: 'Mì cay Hàn Quốc chọn mức độ cay, tokbokki phô mai và cơm trộn nóng hổi.',
    cuisine: 'Korean',
    district: 'Đống Đa',
    address: '16 Phố Tây Sơn, Đống Đa, Hà Nội',
    latitude: 21.0079,
    longitude: 105.825,
    phone: '+84 24 5555 0108',
    opening_hours: '10:00–22:00',
    delivery_fee: 15000,
    eta_minutes: 25,
    rating: 4.5,
    review_count: 305,
    menus: [
      {
        key: 'main',
        name: 'Mì & cơm',
        items: [
          item(
            'mock-item-043',
            'Mì cay hải sản',
            'Mì cay nước dùng hải sản, tôm, mực và rau cải.',
            69000,
            'Mì & cơm',
          ),
          item(
            'mock-item-044',
            'Mì cay bò',
            'Mì cay với thịt bò thái mỏng, nấm và hành lá.',
            65000,
            'Mì & cơm',
          ),
          item(
            'mock-item-048',
            'Cơm trộn Bibimbap',
            'Cơm nóng trộn rau củ, thịt bò, trứng và sốt gochujang.',
            75000,
            'Mì & cơm',
          ),
        ],
      },
      {
        key: 'sides',
        name: 'Món phụ',
        items: [
          item(
            'mock-item-045',
            'Tokbokki phô mai',
            'Bánh gạo dai sốt gochujang phủ phô mai tan chảy.',
            59000,
            'Món phụ',
          ),
          item(
            'mock-item-046',
            'Kimbap bò',
            'Cơm cuộn rong biển nhân bò, trứng và rau củ.',
            45000,
            'Món phụ',
          ),
          item(
            'mock-item-047',
            'Gà sốt cay Hàn Quốc',
            'Gà chiên giòn phủ sốt cay ngọt kiểu Hàn, rắc mè.',
            89000,
            'Món phụ',
          ),
        ],
      },
    ],
  },
  {
    id: 'mock-restaurant-09',
    slug: 'banh-cuon-an-nhien',
    name: 'Bánh Cuốn An Nhiên',
    description: 'Bánh cuốn tráng tại chỗ mỗi sáng, nhân thịt nấm thơm và chả quế nóng.',
    cuisine: 'Vietnamese',
    district: 'Ba Đình',
    address: '9 Phố Nguyễn Thái Học, Ba Đình, Hà Nội',
    latitude: 21.0313,
    longitude: 105.8394,
    phone: '+84 24 5555 0109',
    opening_hours: '06:30–14:00',
    delivery_fee: 12000,
    eta_minutes: 20,
    rating: 4.9,
    review_count: 458,
    menus: [
      {
        key: 'main',
        name: 'Bánh cuốn',
        items: [
          item(
            'mock-item-049',
            'Bánh cuốn truyền thống',
            'Bánh cuốn nhân thịt băm và mộc nhĩ, chấm nước mắm pha.',
            35000,
            'Bánh cuốn',
          ),
          item(
            'mock-item-050',
            'Bánh cuốn chả quế',
            'Bánh cuốn nóng ăn kèm chả quế thơm mùi hồi.',
            45000,
            'Bánh cuốn',
          ),
          item(
            'mock-item-051',
            'Bánh cuốn trứng',
            'Bánh cuốn nhân trứng và thịt, ăn kèm rau thơm.',
            40000,
            'Bánh cuốn',
          ),
        ],
      },
      {
        key: 'extras',
        name: 'Món thêm',
        items: [
          item(
            'mock-item-052',
            'Chả quế thêm',
            'Suất chả quế nướng thêm, ăn kèm bánh cuốn hoặc dùng riêng.',
            20000,
            'Món thêm',
          ),
          item(
            'mock-item-053',
            'Nem rán',
            'Nem thịt rán giòn, nhân miến và mộc nhĩ.',
            30000,
            'Món thêm',
          ),
          item(
            'mock-item-054',
            'Bánh tôm',
            'Bánh tôm chiên giòn với tôm tươi và khoai lang.',
            45000,
            'Món thêm',
          ),
        ],
      },
    ],
  },
  {
    id: 'mock-restaurant-10',
    slug: 'tiem-com-ga-hoi-an',
    name: 'Tiệm Cơm Gà Hội An',
    description: 'Cơm gà Hội An với cơm nghệ, gà xé và rau răm, nước dùng gà nóng.',
    cuisine: 'Vietnamese',
    district: 'Cầu Giấy',
    address: '31 Phố Xuân Thủy, Cầu Giấy, Hà Nội',
    latitude: 21.0366,
    longitude: 105.7899,
    phone: '+84 24 5555 0110',
    opening_hours: '10:00–21:30',
    delivery_fee: 15000,
    eta_minutes: 25,
    rating: 4.6,
    review_count: 233,
    menus: [
      {
        key: 'main',
        name: 'Cơm gà',
        items: [
          item(
            'mock-item-055',
            'Cơm gà xé',
            'Cơm nghệ trộn gà xé, rau răm, hành phi và nước mắm chua ngọt.',
            55000,
            'Cơm gà',
          ),
          item(
            'mock-item-056',
            'Cơm gà quay',
            'Đùi gà quay da giòn trên cơm nghệ, ăn kèm salad.',
            65000,
            'Cơm gà',
          ),
          item(
            'mock-item-057',
            'Cơm gà đùi',
            'Cơm nghệ với một đùi gà luộc mềm và nước dùng riêng.',
            69000,
            'Cơm gà',
          ),
        ],
      },
      {
        key: 'extras',
        name: 'Món thêm',
        items: [
          item(
            'mock-item-058',
            'Gỏi gà xé phay',
            'Gà xé trộn bắp cải, rau răm, hành tây và nước mắm chua cay.',
            45000,
            'Món thêm',
          ),
          item(
            'mock-item-059',
            'Súp gà',
            'Súp gà nóng với nấm, ngô và trứng, vị thanh nhẹ.',
            25000,
            'Món thêm',
          ),
          item(
            'mock-item-060',
            'Trứng non xào',
            'Trứng non xào hành tây và tiêu, ăn cùng cơm gà.',
            45000,
            'Món thêm',
          ),
        ],
      },
    ],
  },
];

export const MOCK_RESTAURANT_IDS = MOCK_RESTAURANTS.map((restaurant) => restaurant.id);

export const MOCK_ITEM_IDS = MOCK_RESTAURANTS.flatMap((restaurant) =>
  restaurant.menus.flatMap((menu) => menu.items.map((menuItem) => menuItem.id)),
);

/** Every raster path the UI expects: 10 covers + 60 dish photos. */
export const MOCK_IMAGE_PATHS = [
  ...MOCK_RESTAURANTS.map((restaurant) => restaurantImage(restaurant.slug)),
  ...MOCK_RESTAURANTS.flatMap((restaurant) =>
    restaurant.menus.flatMap((menu) => menu.items.map((menuItem) => itemImage(menuItem.id))),
  ),
];

/** Legacy demo rows created by `server/seed.ts`; hidden, never deleted. */
export const LEGACY_DEMO_RESTAURANT_IDS = ['saigon', 'pizza', 'green'];
