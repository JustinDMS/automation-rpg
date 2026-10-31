// Progression: language tiers (the tech tree) unlocked by goals scored on live runs.

import type { StmtKind } from './lang';
import type { MapType } from './map';

/** A goal is judged on the average of this many consecutive runs (each on a new map) with one program. */
export const TRIAL_RUNS = 3;

export interface Goal {
  type: MapType;
  explored: number; // average % explored needed
  starLines: number; // optional bonus: reach the goal in this many lines or fewer
}

export interface Tier {
  tier: number;
  name: string;
  grants: string;
  kinds: StmtKind[]; // statement kinds this tier adds to the palette
  goal: Goal | null; // goal that unlocks this tier
}

export const TIERS: Tier[] = [
  { tier: 0, name: 'Motors', grants: 'forward, turn_left, turn_right, wait', kinds: ['act'], goal: null },
  { tier: 1, name: 'Sensors', grants: 'if / else and sensors · new map: maze', kinds: ['if'], goal: { type: 'field', explored: 10, starLines: 5 } },
  { tier: 2, name: 'Memory', grants: 'variables a and b · new map: caves', kinds: ['set', 'add'], goal: { type: 'maze', explored: 50, starLines: 6 } },
  { tier: 3, name: 'Loops', grants: 'repeat and while', kinds: ['repeat', 'while'], goal: { type: 'caves', explored: 60, starLines: 5 } },
];

/** Language tier needed before a map type can be explored. */
export const MAP_TIER: Record<MapType, number> = { field: 0, maze: 1, caves: 2 };

/** Open-ended targets once the tech tree is done: the long-tail challenge layer. */
export const MASTERY: { type: MapType; explored: number; label: string }[] = [
  { type: 'field', explored: 70, label: 'Field 70%' },
  { type: 'maze', explored: 100, label: 'Maze 100%' },
  { type: 'caves', explored: 100, label: 'Caves 100%' },
];

export function kindsForTier(tier: number): Set<StmtKind> {
  return new Set(TIERS.filter((t) => t.tier <= tier).flatMap((t) => t.kinds));
}

/** The goal the player is working toward, or null once every tier is unlocked. */
export function nextTier(tier: number): Tier | null {
  return TIERS[tier + 1] ?? null;
}

export interface TrialOutcome {
  tier: number;
  stars: number[]; // tiers whose bonus star is earned
  unlocked: number | null;
  newStars: number[];
}

/** Apply a completed trial (average over TRIAL_RUNS runs) to progression. */
export function evaluateTrial(tier: number, stars: number[], type: MapType, avg: number, lines: number): TrialOutcome {
  let unlocked: number | null = null;
  const next = nextTier(tier);
  if (next?.goal && next.goal.type === type && avg >= next.goal.explored) {
    tier = next.tier;
    unlocked = next.tier;
  }
  const newStars = TIERS.filter((t) =>
    t.goal && t.tier <= tier && !stars.includes(t.tier) &&
    t.goal.type === type && avg >= t.goal.explored && lines <= t.goal.starLines,
  ).map((t) => t.tier);
  return { tier, stars: [...stars, ...newStars], unlocked, newStars };
}
