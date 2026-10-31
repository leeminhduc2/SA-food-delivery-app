import 'dotenv/config';
import { prisma, transaction } from './db.js';
import { hashPassword } from './services/identity.service.js';
import type { Prisma } from '@prisma/client';

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
      // `update: {}` preserves existing credentials and profile changes.
      await db.user.upsert({
        where: { id },
        update: {},
        create: { id, email: `${id}@bep.local`, name, password_hash: hash, role },
      });
    const restaurants: Array<{
      id: string;
      name: string;
      description: string;
      address: string;
      cuisine: string;
      image: string;
      fee: number;
      eta: number;
    }> = [
      {
        id: 'saigon',
        name: 'Bếp Nhà Sài Gòn',
        description:
          'Comfort food, made the way home feels. Fresh herbs, slow-simmered broths, and a little love in every bowl.',
        address: '24 Nguyễn Huệ, District 1, Ho Chi Minh City',
        cuisine: 'Vietnamese',
        image: '/images/vietnamese.svg',
        fee: 15000,
        eta: 25,
      },
      {
        id: 'pizza',
        name: 'Little Italy Kitchen',
        description:
          'Hand-stretched dough, bright tomatoes, and generous slices. Your neighborhood Italian kitchen.',
        address: '18 Lê Lợi, District 1, Ho Chi Minh City',
        cuisine: 'Italian',
        image: '/images/pizza.svg',
        fee: 20000,
        eta: 35,
      },
      {
        id: 'green',
        name: 'The Green Table',
        description:
          'Feel-good bowls filled with seasonal vegetables, grains, and house-made dressings.',
        address: '52 Pasteur, District 3, Ho Chi Minh City',
        cuisine: 'Healthy',
        image: '/images/healthy.svg',
        fee: 12000,
        eta: 20,
      },
    ];
    for (const restaurant of restaurants) {
      await db.restaurant.upsert({
        where: { id: restaurant.id },
        update: {},
        create: {
          id: restaurant.id,
          name: restaurant.name,
          description: restaurant.description,
          address: restaurant.address,
          cuisine: restaurant.cuisine,
          image: restaurant.image,
          delivery_fee: restaurant.fee,
          eta_minutes: restaurant.eta,
          status: 'APPROVED',
          approved_at: new Date(),
        },
      });
    }
    await db.restaurantMember.createMany({
      data: [
        { user_id: 'restaurant', restaurant_id: 'saigon' },
        { user_id: 'restaurant2', restaurant_id: 'pizza' },
        { user_id: 'restaurant2', restaurant_id: 'green' },
      ],
      skipDuplicates: true,
    });
    for (const restaurant of restaurants)
      await db.menu.upsert({
        where: { id: `${restaurant.id}-main` },
        update: {},
        create: {
          id: `${restaurant.id}-main`,
          restaurant_id: restaurant.id,
          name: 'House favorites',
        },
      });
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
    ] as const;
    await db.menuItem.createMany({
      data: items.map(([iid, rid, name, desc, price, img]) => ({
        id: iid,
        restaurant_id: rid,
        menu_id: `${rid}-main`,
        name,
        description: desc,
        price,
        image: `/images/${img}.svg`,
        options: [
          { id: 'extra', name: 'Extra portion', extraPrice: 15000 },
        ] as unknown as Prisma.InputJsonValue,
      })),
      skipDuplicates: true,
    });
  });
}
if (process.argv[1]?.endsWith('seed.ts')) {
  await seed();
  console.log('Demo data seeded; existing records preserved.');
  await prisma.$disconnect();
}
