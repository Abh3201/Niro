import type { Limits } from "./server";

/** Environment variables that override the default limits, and the limit each sets. */
const LIMIT_VARIABLES = {
  NIRO_MAX_SHAPES: { limit: "shapes", scale: 1 },
  NIRO_MAX_BOARD_MB: { limit: "documentBytes", scale: 1024 * 1024 },
  NIRO_MAX_CONNECTIONS_PER_BOARD: { limit: "connectionsPerRoom", scale: 1 },
  NIRO_MAX_OPEN_MB: { limit: "openBytes", scale: 1024 * 1024 },
  NIRO_MAX_CONNECTIONS: { limit: "connections", scale: 1 },
  NIRO_MAX_IMAGE_MB: { limit: "imageBytes", scale: 1024 * 1024 },
  NIRO_MAX_BOARD_IMAGES_MB: { limit: "boardImageBytes", scale: 1024 * 1024 },
} as const satisfies Record<string, { limit: keyof Limits; scale: number }>;

/** Limits set in the environment. Unset or empty variables keep the default; anything else must be a positive whole number. */
export function limitsFromEnv(env: Record<string, string | undefined>): Partial<Limits> {
  const limits: Partial<Limits> = {};
  for (const [name, { limit, scale }] of Object.entries(LIMIT_VARIABLES)) {
    const value = env[name]?.trim();
    if (!value) continue;
    if (!/^[1-9][0-9]*$/.test(value)) {
      throw new Error(`${name} must be a positive whole number, not "${value}".`);
    }
    limits[limit] = Number(value) * scale;
  }
  return limits;
}
