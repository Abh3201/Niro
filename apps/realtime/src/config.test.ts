import { describe, expect, it } from "vitest";
import { limitsFromEnv } from "./config";

describe("limitsFromEnv", () => {
  it("reads the limits that are set, in their units", () => {
    expect(limitsFromEnv({})).toEqual({});
    expect(
      limitsFromEnv({
        NIRO_MAX_SHAPES: "50000",
        NIRO_MAX_BOARD_MB: "64",
        NIRO_MAX_CONNECTIONS_PER_BOARD: "",
        NIRO_MAX_OPEN_MB: "10",
        NIRO_MAX_CONNECTIONS: "5",
      }),
    ).toEqual({
      shapes: 50_000,
      documentBytes: 64 * 1024 * 1024,
      openBytes: 10 * 1024 * 1024,
      connections: 5,
    });
  });

  it("refuses values that aren't positive whole numbers", () => {
    for (const value of ["0", "-1", "1.5", "lots", "1e3"]) {
      expect(() => limitsFromEnv({ NIRO_MAX_SHAPES: value })).toThrow("NIRO_MAX_SHAPES");
    }
  });
});
