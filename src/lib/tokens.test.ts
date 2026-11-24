import { describe, expect, it } from "vitest";
import {
  formatAmount,
  formatLiquidity,
  formatUsdish,
  parseAmount,
  shortAddress,
} from "./tokens";

describe("formatLiquidity", () => {
  it("renders small values in full with separators", () => {
    expect(formatLiquidity(0n)).toBe("0");
    expect(formatLiquidity(123456n)).toBe("123,456");
    expect(formatLiquidity(999999n)).toBe("999,999");
  });

  it("renders huge pool liquidity as a short exponential", () => {
    // Real values seen in the Tidepool Pools table, 24 Nov 2026.
    expect(formatLiquidity(3691112629494129789173957760676973n)).toBe("3.69e33");
    expect(formatLiquidity(3686528836880418846186938660209249n)).toBe("3.68e33");
    expect(formatLiquidity(3728220333073698571407575411360628n)).toBe("3.72e33");
    expect(formatLiquidity(32544325475902668322789172841934n)).toBe("3.25e31");
    expect(formatLiquidity(561834518497874881773348125n)).toBe("5.61e26");
  });

  it("trims trailing zeros in the mantissa", () => {
    expect(formatLiquidity(1000000n)).toBe("1e6");
    expect(formatLiquidity(1050000n)).toBe("1.05e6");
  });
});

describe("formatAmount", () => {
  it("handles zero and dust", () => {
    expect(formatAmount(0n, 18)).toBe("0");
    expect(formatAmount(1n, 18)).toBe("<0.000001");
  });

  it("adapts precision by magnitude", () => {
    expect(formatAmount(500000000000000000n, 18)).toBe("0.5");
    expect(formatAmount(1234567890000000000n, 18)).toBe("1.2346");
    expect(formatAmount(1234567000000000000000n, 18)).toBe("1234.57");
    expect(formatAmount(1500000000000000000000000n, 18)).toBe("1,500,000");
  });

  it("appends the symbol when given", () => {
    expect(formatAmount(1000000000000000000n, 18, "WETH")).toBe("1 WETH");
  });
});

describe("parseAmount", () => {
  it("parses valid human amounts", () => {
    expect(parseAmount("1.5", 18)).toBe(1500000000000000000n);
    expect(parseAmount("0.000000000000000001", 18)).toBe(1n);
    expect(parseAmount("0", 18)).toBe(0n);
  });

  it("rejects empty and malformed input", () => {
    expect(parseAmount("", 18)).toBeNull();
    expect(parseAmount("abc", 18)).toBeNull();
    expect(parseAmount("1.2.3", 18)).toBeNull();
    expect(parseAmount("-1", 18)).toBeNull();
  });
});

describe("shortAddress", () => {
  it("keeps the head and tail of an address", () => {
    expect(shortAddress("0xf04c62C4634DacA5e46528E16F654510ea1a1849")).toBe("0xf04c…1849");
  });
});

describe("formatUsdish", () => {
  it("formats finite numbers and blanks the rest", () => {
    expect(formatUsdish(1.23456789)).toBe("1.2346");
    expect(formatUsdish(Number.NaN)).toBe("—");
    expect(formatUsdish(Number.POSITIVE_INFINITY)).toBe("—");
  });
});
