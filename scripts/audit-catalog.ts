import 'dotenv/config';
import { prisma } from '../server/db.js';

const [
  total,
  visible,
  bySource,
  items,
  menus,
  orders,
  orderItems,
  payments,
  reviews,
  carts,
  members,
] = await Promise.all([
  prisma.restaurant.count(),
  prisma.restaurant.count({ where: { catalog_visible: true } }),
  prisma.restaurant.groupBy({ by: ['source'], _count: { _all: true } }),
  prisma.menuItem.count(),
  prisma.menu.count(),
  prisma.order.count(),
  prisma.orderItem.count(),
  prisma.payment.count(),
  prisma.review.count(),
  prisma.cart.count(),
  prisma.restaurantMember.count(),
]);
const leftoverSchemas = await prisma.$queryRawUnsafe<{ schema_name: string }[]>(
  "select schema_name from information_schema.schemata where schema_name like 'test_%' or schema_name like 'e2e_%'",
);
console.log(
  JSON.stringify(
    {
      restaurants: { total, visible, bySource: bySource.map((g) => [g.source, g._count._all]) },
      menuItems: items,
      menus,
      orders,
      orderItems,
      payments,
      reviews,
      carts,
      restaurantMembers: members,
      leftoverTestSchemas: leftoverSchemas.map((row: { schema_name: string }) => row.schema_name),
    },
    null,
    2,
  ),
);
await prisma.$disconnect();
