import { id, prisma, type DB } from '../../../shared/db.js';

export type AddressRow = {
  id: string;
  user_id: string;
  address: string;
  formatted_address: string | null;
  latitude: number;
  longitude: number;
  is_default: boolean;
  created_at: Date | string;
  updated_at: Date | string;
};

export async function findDefault(
  userId: string,
  db: DB = prisma,
): Promise<AddressRow | undefined> {
  return (
    ((await db.address.findFirst({
      where: { user_id: userId, is_default: true },
    })) as AddressRow | null) ?? undefined
  );
}

export async function saveDefault(
  userId: string,
  input: {
    address: string;
    formattedAddress: string;
    latitude: number;
    longitude: number;
  },
  db: DB = prisma,
): Promise<AddressRow> {
  const existing = await findDefault(userId, db);
  if (existing) {
    return (await db.address.update({
      where: { id: existing.id },
      data: {
        address: input.address,
        formatted_address: input.formattedAddress,
        latitude: input.latitude,
        longitude: input.longitude,
        is_default: true,
      },
    })) as AddressRow;
  }
  return (await db.address.create({
    data: {
      id: id(),
      user_id: userId,
      address: input.address,
      formatted_address: input.formattedAddress,
      latitude: input.latitude,
      longitude: input.longitude,
      is_default: true,
    },
  })) as AddressRow;
}
