import { z } from 'zod';
export const Id = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9_.:-]+$/);
export const SessionInput = z
  .object({
    request_id: Id,
    text: z.string().min(1).max(16000),
    session_id: z
      .string()
      .min(1)
      .max(256)
      .refine((value) => !/[\r\n\0]/.test(value))
      .nullable()
      .optional(),
  })
  .strict();
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
