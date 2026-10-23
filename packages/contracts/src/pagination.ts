import { z } from 'zod';

export const PaginationQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const PaginatedMetaSchema = z.object({
  nextCursor: z.string().nullable(),
  limit: z.number().int(),
});

export type PaginationQuery = z.infer<typeof PaginationQuerySchema>;
