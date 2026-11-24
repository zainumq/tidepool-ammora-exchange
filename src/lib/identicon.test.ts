import { describe, expect, it } from "vitest";
import { getIdenticon } from "./identicon";

/** KPTEST token address — the pinned cross-app reference. */
const KPTEST = "0xf04c62C4634DacA5e46528E16F654510ea1a1849";

describe("getIdenticon", () => {
  it("is pinned for the KPTEST address (same icon in both apps)", () => {
    const icon = getIdenticon(KPTEST);
    expect(icon.foreground).toBe("hsl(112, 65%, 48%)");
    expect(icon.background).toBe("hsl(112, 45%, 92%)");
    expect(icon.cells).toEqual([
      true, true, true, true, true,
      true, true, true, true, true,
      false, false, false, false, false,
      false, false, false, false, false,
      false, true, true, true, false,
    ]);
  });

  it("is deterministic and case-insensitive", () => {
    expect(getIdenticon(KPTEST)).toEqual(getIdenticon(KPTEST));
    expect(getIdenticon(KPTEST.toLowerCase())).toEqual(getIdenticon(KPTEST.toUpperCase()));
  });

  it("produces a 5x5 grid mirrored left-right", () => {
    const { cells } = getIdenticon(KPTEST);
    expect(cells).toHaveLength(25);
    for (let row = 0; row < 5; row++) {
      expect(cells[row * 5 + 0]).toBe(cells[row * 5 + 4]);
      expect(cells[row * 5 + 1]).toBe(cells[row * 5 + 3]);
    }
  });

  it("differs between addresses", () => {
    const other = getIdenticon("0x4200000000000000000000000000000000000006");
    expect(other.foreground).toBe("hsl(187, 65%, 48%)");
    expect(other).not.toEqual(getIdenticon(KPTEST));
  });
});
