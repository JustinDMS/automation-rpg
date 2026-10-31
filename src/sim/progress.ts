// Progression: language tiers (the tech tree), map unlocks and hardware upgrades.

import type { StmtKind } from './lang';
import type { MapType } from './map';
import type { BenchResult } from './run';

export interface Tier {
  tier: number;
  name: string;
  grants: string;
  kinds: StmtKind[]; // statement kinds this tier adds to the palette
  /** Benchmark target that unlocks this tier. */
  req: { type: MapType; explored: number } | null;
}

export const TIERS: Tier[] = [
  { tier: 0, name: 'Motors', grants: 'forward, turn_left, turn_right, wait', kinds: ['act'], req: null },
  { tier: 1, name: 'Sensors', grants: 'if / else, wall, visited, loot and coin sensors', kinds: ['if'], req: { type: 'field', explored: 10 } },
  { tier: 2, name: 'Memory', grants: 'variables a and b', kinds: ['set', 'add'], req: { type: 'maze', explored: 50 } },
  { tier: 3, name: 'Loops', grants: 'repeat and while', kinds: ['repeat', 'while'], req: { type: 'caves', explored: 75 } },
];

/** Language tier needed before a map type can be explored. */
export const MAP_TIER: Record<MapType, number> = { field: 0, maze: 1, caves: 2 };

/** Optional mastery targets once the tech tree is done: the long-tail challenge layer. */
export const MASTERY: { type: MapType; explored: number; label: string }[] = [
  { type: 'field', explored: 70, label: 'Field 70%' },
  { type: 'maze', explored: 100, label: 'Maze 100%' },
  { type: 'caves', explored: 100, label: 'Caves 100%' },
];

export const BASE_SLOTS = 8;
export const SLOTS_PER_UPGRADE = 2;
export const slotUpgradeCost = (owned: number) => 8 * 2 ** owned;
export const maxSlots = (upgrades: number) => BASE_SLOTS + SLOTS_PER_UPGRADE * upgrades;

export function kindsForTier(tier: number): Set<StmtKind> {
  return new Set(TIERS.filter((t) => t.tier <= tier).flatMap((t) => t.kinds));
}

/** Highest tier unlocked by the given best benchmark results. Tiers unlock in order. */
export function tierFromBests(bests: Partial<Record<MapType, BenchResult>>): number {
  let tier = 0;
  for (const t of TIERS) {
    if (!t.req) continue;
    const b = bests[t.req.type];
    if (b && b.explored >= t.req.explored && tier === t.tier - 1) tier = t.tier;
  }
  return tier;
}

/** Keep the better of two results: more explored, then fewer ticks. */
export function better(a: BenchResult | undefined, b: BenchResult): BenchResult {
  if (!a) return b;
  if (b.explored !== a.explored) return b.explored > a.explored ? b : a;
  return b.ticks < a.ticks ? b : a;
}
