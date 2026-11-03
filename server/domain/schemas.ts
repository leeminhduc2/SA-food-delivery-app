import { z } from 'zod';

export const lineSchema = z.object({
  itemId: z.string().min(1),
  quantity: z.number().int().min(1).max(20),
  optionIds: z.array(z.string()).max(10).default([]),
});

export const linesSchema = z.array(lineSchema).min(1).max(40);

export const imageSchema = z
  .string()
  .max(1000)
  .refine(
    (s) =>
      !s ||
      /^https:\/\//.test(s) ||
      (/^\/images\/[a-z0-9][a-z0-9._/-]*$/.test(s) && !s.includes('..')),
    'Use an HTTPS image URL or a local /images/ path.',
  );
