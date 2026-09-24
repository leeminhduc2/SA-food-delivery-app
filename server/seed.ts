import 'dotenv/config';
import { pool, transaction } from './db.js';
import { hashPassword } from './modules/identity.js';
export async function seed() {
  if (process.env.DEMO_MODE !== 'true')
    throw new Error('Seed is only available with DEMO_MODE=true.');
  const password = process.env.DEMO_PASSWORD;
  if (!password || password.length < 10) throw new Error('Set DEMO_PASSWORD (10+ characters).');
  const hash = await hashPassword(password);
  await transaction(async (db) => {
    for (const [id, name, role] of [
      ['customer', 'Minh Anh', 'CUSTOMER'],
      ['restaurant', 'Linh Nguyễn', 'RESTAURANT'],
      ['restaurant2', 'An Trần', 'RESTAURANT'],
      ['driver', 'Đức Lê', 'DRIVER'],
      ['driver2', 'Nam Phạm', 'DRIVER'],
      ['admin', 'Bếp Operations', 'ADMIN'],
    ])
      await db.query(
        'INSERT INTO users(id,email,name,password_hash,role) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING',
        [id, `${id}@bep.local`, name, hash, role],
      );
    const restaurants = [
      [
        'saigon',
        'Bếp Nhà Sài Gòn',
        'Comfort food, made the way home feels. Fresh herbs, slow-simmered broths, and a little love in every bowl.',
        '24 Nguyễn Huệ, District 1, Ho Chi Minh City',
        'Vietnamese',
        '/images/vietnamese.svg',
        15000,
        25,
      ],
      [
        'pizza',
        'Little Italy Kitchen',
        'Hand-stretched dough, bright tomatoes, and generous slices. Your neighborhood Italian kitchen.',
        '18 Lê Lợi, District 1, Ho Chi Minh City',
        'Italian',
        '/images/pizza.svg',
        20000,
        35,
      ],
      [
        'green',
        'The Green Table',
        'Feel-good bowls filled with seasonal vegetables, grains, and house-made dressings.',
        '52 Pasteur, District 3, Ho Chi Minh City',
        'Healthy',
        '/images/healthy.svg',
        12000,
        20,
      ],
    ];
    for (const [rid, name, desc, address, cuisine, image, fee, eta] of restaurants) {
      await db.query(
        "INSERT INTO restaurants(id,name,description,address,cuisine,image,delivery_fee,eta_minutes,status,approved_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'APPROVED',now()) ON CONFLICT(id) DO NOTHING",
        [rid, name, desc, address, cuisine, image, fee, eta],
      );
      await db.query('INSERT INTO restaurant_members VALUES($1,$2) ON CONFLICT DO NOTHING', [
        rid === 'saigon' ? 'restaurant' : 'restaurant2',
        rid,
      ]);
      await db.query(
        'INSERT INTO menus(id,restaurant_id,name) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING',
        [`${rid}-main`, rid, 'House favorites'],
      );
    }
    const items = [
      [
        'pho',
        'saigon',
        'Phở bò đặc biệt',
        'Slow-cooked beef broth, rice noodles, brisket, fresh herbs.',
        65000,
        'vietnamese',
      ],
      [
        'banhmi',
        'saigon',
        'Bánh mì Sài Gòn',
        'Crisp baguette, grilled pork, pickled vegetables, house pâté.',
        35000,
        'sandwich',
      ],
      [
        'rice',
        'saigon',
        'Cơm tấm sườn nướng',
        'Grilled lemongrass pork, broken rice, pickles, fish sauce.',
        60000,
        'rice',
      ],
      [
        'rolls',
        'saigon',
        'Gỏi cuốn tôm',
        'Fresh rice-paper rolls, shrimp, greens, peanut dipping sauce.',
        45000,
        'healthy',
      ],
      [
        'margherita',
        'pizza',
        'Margherita pizza',
        'San Marzano tomato, mozzarella, basil, extra virgin olive oil.',
        125000,
        'pizza',
      ],
      [
        'pesto',
        'pizza',
        'Pesto garden pizza',
        'Basil pesto, roasted vegetables, fresh mozzarella.',
        145000,
        'pizza',
      ],
      [
        'bowl',
        'green',
        'Harvest bowl',
        'Brown rice, roasted pumpkin, avocado, chickpeas, tahini.',
        75000,
        'healthy',
      ],
      [
        'salad',
        'green',
        'Citrus crunch salad',
        'Seasonal greens, orange, toasted seeds, citrus dressing.',
        65000,
        'healthy',
      ],
    ];
    for (const [iid, rid, name, desc, price, img] of items)
      await db.query(
        'INSERT INTO menu_items(id,restaurant_id,menu_id,name,description,price,image,options) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO NOTHING',
        [
          iid,
          rid,
          `${rid}-main`,
          name,
          desc,
          price,
          `/images/${img}.svg`,
          JSON.stringify([{ id: 'extra', name: 'Extra portion', extraPrice: 15000 }]),
        ],
      );
  });
}
if (process.argv[1]?.endsWith('seed.ts')) {
  await seed();
  console.log('Demo data seeded; existing records preserved.');
  await pool.end();
}
