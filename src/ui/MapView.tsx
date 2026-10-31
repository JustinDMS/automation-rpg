import { useEffect, useRef } from 'react';
import type { World } from '../sim/run';

const COLORS = {
  fog: '#0e1116',
  wall: '#5b6370',
  floor: '#262c34',
  visited: '#2f4a3a',
  loot: '#e5b93a',
  rover: '#5ab0ff',
};

/** Grey-box map: squares and a triangle. Redraws whenever the world's tick changes. */
export function MapView({ world }: { world: World }) {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const size = world.map.size;
    const px = c.clientWidth;
    const dpr = window.devicePixelRatio || 1;
    if (c.width !== Math.round(px * dpr)) { c.width = Math.round(px * dpr); c.height = Math.round(px * dpr); }
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cell = px / size;

    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const i = y * size + x;
      g.fillStyle = !world.revealed[i] ? COLORS.fog : world.map.walls[i] ? COLORS.wall : world.visited[i] ? COLORS.visited : COLORS.floor;
      g.fillRect(x * cell, y * cell, cell + 0.5, cell + 0.5);
      if (world.revealed[i] && world.loot[i]) {
        g.fillStyle = COLORS.loot;
        g.beginPath();
        g.arc((x + 0.5) * cell, (y + 0.5) * cell, cell * 0.22, 0, Math.PI * 2);
        g.fill();
      }
    }

    // Rover: a triangle pointing the way it faces.
    const cx = (world.x + 0.5) * cell, cy = (world.y + 0.5) * cell, r = cell * 0.38;
    g.save();
    g.translate(cx, cy);
    g.rotate((world.dir * Math.PI) / 2);
    g.fillStyle = COLORS.rover;
    g.beginPath();
    g.moveTo(0, -r);
    g.lineTo(r * 0.8, r * 0.8);
    g.lineTo(-r * 0.8, r * 0.8);
    g.closePath();
    g.fill();
    g.restore();
  });

  return <canvas ref={canvas} className="map" aria-label="Exploration map" />;
}
