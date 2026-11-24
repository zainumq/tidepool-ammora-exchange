/**
 * Deterministic blockies-style token identicon derivation.
 *
 * Ammora launches carry no logo metadata on-chain (name/symbol/decimals
 * only), so every token gets a generated face derived from its address.
 * This file is IDENTICAL in KongPad and Tidepool — same seed, grid, and
 * palette — so one address renders the same icon in both apps. If you
 * change it here, change it in the other app too.
 *
 * Algorithm: FNV-1a 32-bit hash of the lowercased address seeds a
 * mulberry32 PRNG. The PRNG picks a hue (0–359) and fills a 5×5 grid,
 * mirrored left–right (columns 0–2 random, column 3 mirrors 1, column 4
 * mirrors 0). Foreground is hsl(hue, 65%, 48%) on a light tile
 * hsl(hue, 45%, 92%) — the tile is part of the icon, so it looks the
 * same on a light theme (KongPad) and a dark theme (Tidepool).
 */

const GRID = 5;

export interface IdenticonData {
  background: string;
  foreground: string;
  /** Row-major 5×5 fill flags; mirrored columns already applied. */
  cells: boolean[];
}

function hashSeed(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pure identicon derivation — exported so both apps can be compared. */
export function getIdenticon(address: string): IdenticonData {
  const rand = mulberry32(hashSeed(address.toLowerCase()));
  const hue = Math.floor(rand() * 360);
  const cells: boolean[] = new Array(GRID * GRID).fill(false);
  for (let row = 0; row < GRID; row++) {
    for (let col = 0; col < 3; col++) {
      const filled = rand() < 0.5;
      cells[row * GRID + col] = filled;
      cells[row * GRID + (GRID - 1 - col)] = filled;
    }
  }
  return {
    background: `hsl(${hue}, 45%, 92%)`,
    foreground: `hsl(${hue}, 65%, 48%)`,
    cells,
  };
}
