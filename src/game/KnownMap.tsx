import type { Kind, State } from './world';

/**
 * What you know, drawn: every discovered place, where you are, and the ring of places you
 * can reach and still walk back from on the supplies you carry (half your supplies, in leagues).
 */
const COLOR: Record<Kind, string> = {
  camp: '#e5b93a', meadow: '#8fcf6a', forest: '#3f9b5a', ruin: '#b7a58c', cave: '#9b7fd1', mine: '#c07a4a',
};

const W = 600, H = 600, PAD = 60, FONT = 15, CHAR = 7.6;

interface Box { x: number; y: number; w: number; h: number }
const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

export function KnownMap({ state }: { state: State }) {
  const known = state.places.filter((p) => p.discovered);
  const here = state.places[state.here];
  const xs = known.map((p) => p.x), ys = known.map((p) => p.y);
  // Square bounds around everything known, so leagues read the same in both directions.
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const span = Math.max(8, Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  const k = (W - 2 * PAD) / span;
  const X = (x: number) => W / 2 + (x - cx) * k, Y = (y: number) => H / 2 + (y - cy) * k;

  // Place each label beside its dot where it collides with nothing placed so far:
  // right, left, below, above, then further out, never past the edge.
  const taken: Box[] = known.map((p) => ({ x: X(p.x) - 8, y: Y(p.y) - 8, w: 16, h: 16 }));
  taken.push({ x: X(here.x) - 16, y: Y(here.y) - 16, w: 32, h: 32 });
  const labels = known.map((p) => {
    const x = X(p.x), y = Y(p.y), w = p.name.length * CHAR, h = FONT + 2;
    const tries: [number, number, 'start' | 'end' | 'middle'][] = [
      [x + 18, y + 5, 'start'], [x - 18, y + 5, 'end'], [x, y + 26, 'middle'], [x, y - 16, 'middle'],
      [x + 18, y + 22, 'start'], [x + 18, y - 12, 'start'], [x - 18, y + 22, 'end'], [x - 18, y - 12, 'end'],
    ];
    const box = ([tx, ty, a]: (typeof tries)[number]): Box => ({ x: a === 'start' ? tx : a === 'end' ? tx - w : tx - w / 2, y: ty - FONT + 2, w, h });
    const inside = (b: Box) => b.x >= 4 && b.y >= 4 && b.x + b.w <= W - 4 && b.y + b.h <= H - 4;
    const pick = tries.find((t) => inside(box(t)) && !taken.some((b) => overlaps(box(t), b)))
      ?? tries.find((t) => inside(box(t))) ?? tries[0];
    taken.push(box(pick));
    return { id: p.id, x: pick[0], y: pick[1], anchor: pick[2] };
  });

  return (
    <svg className="known-map" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Map of known places">
      <circle cx={X(here.x)} cy={Y(here.y)} r={(state.supplies / 2) * k} className="reach" />
      {known.map((p, i) => {
        const x = X(p.x), y = Y(p.y), empty = p.seen === 0 && p.kind !== 'camp' && !p.outpost, l = labels[i];
        return (
          <g key={p.id} opacity={empty ? 0.45 : 1}>
            {p.kind === 'camp'
              ? <rect x={x - 7} y={y - 7} width={14} height={14} fill={COLOR.camp} />
              : p.outpost
                ? <rect x={x - 7} y={y - 7} width={14} height={14} fill={COLOR[p.kind]} stroke={COLOR.camp} strokeWidth={3} />
                : <circle cx={x} cy={y} r={6} fill={COLOR[p.kind]} />}
            <text x={l.x} y={l.y} textAnchor={l.anchor} className="label">{p.name}</text>
          </g>
        );
      })}
      <circle cx={X(here.x)} cy={Y(here.y)} r={13} className={state.pending ? 'you warn' : 'you'} />
    </svg>
  );
}
