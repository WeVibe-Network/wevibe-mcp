import { z } from 'zod';

export const MC_VERSION = 1 as const;

/** The MC-1 write-side envelope stamped on every extracted memory. Field routing per INV-6:
 * these are keyword/payload-channel fields, NOT the dense query. */
export const Mc1WriteEnvelopeSchema = z.object({
  mc_version: z.literal(MC_VERSION),
  org_id: z.string().min(1),
  language: z.array(z.string()).optional(),
  deps: z.array(z.string()).optional(),
  paths: z.array(z.string()).optional(),
  symbols: z.array(z.string()).optional(),
  keywords: z.array(z.string()), // vocab-constrained terms (lowercased); may be empty (INV-7 graceful)
}).strict();

export type Mc1WriteEnvelope = z.infer<typeof Mc1WriteEnvelopeSchema>;

/** Throwing validator + a safe boolean variant. */
export function validateMc1WriteEnvelope(value: unknown): Mc1WriteEnvelope {
  return Mc1WriteEnvelopeSchema.parse(value);
}

export function isValidMc1WriteEnvelope(value: unknown): boolean {
  return Mc1WriteEnvelopeSchema.safeParse(value).success;
}
