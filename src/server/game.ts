import {
  GRID_W, GRID_H, TICK_MS, COUNTDOWN_MS, ROUND_OVER_MS,
  Dir, Phase, OPPOSITE, DELTA, PlayerInfo, PlayerState, ServerMsg,
} from '../shared/protocol';

const COLORS = [
  '#00e5ff', '#ff9d00', '#76ff03', '#ff2975',
  '#ffee00', '#b388ff', '#00ffb3', '#ff5252',
];

export interface Client {
  send(msg: ServerMsg): void;
}

interface Player {
  id: string;
  name: string;
  color: string;
  score: number;
  alive: boolean;
  spectating: boolean;
  x: number;
  y: number;
  dir: Dir;
  pendingDirs: Dir[]; // small queue so rapid double-turns land on consecutive ticks
  trail: [number, number][];
  client: Client;
}

type SpawnPattern = 'columns' | 'perimeter' | 'circle';
const SPAWN_PATTERNS: SpawnPattern[] = ['columns', 'perimeter', 'circle'];
const ROUNDS_PER_PATTERN = 3;

export class Game {
  private players = new Map<string, Player>();
  private grid = new Map<number, string>(); // cell index -> player id
  private phase: Phase = 'waiting';
  private phaseEndsAt: number | null = null;
  private nextColor = 0;
  private round = 0;

  start(): void {
    setInterval(() => this.tick(), TICK_MS);
  }

  addPlayer(id: string, name: string, client: Client): void {
    const player: Player = {
      id,
      name,
      color: COLORS[this.nextColor++ % COLORS.length],
      score: 0,
      alive: false,
      spectating: this.phase === 'playing',
      x: 0, y: 0, dir: 'right', pendingDirs: [],
      trail: [],
      client,
    };
    this.players.set(id, player);
    client.send({ t: 'welcome', id });
    client.send(this.snapshot());
    this.broadcastRoster();
  }

  removePlayer(id: string): void {
    const player = this.players.get(id);
    if (!player) return;
    this.players.delete(id);
    // Trail cells stay on the grid until the round ends.
    if (player.alive && this.phase === 'playing') {
      this.broadcast({ t: 'tick', heads: [], deaths: [id] });
    }
    this.broadcastRoster();
  }

  turn(id: string, dir: Dir): void {
    const player = this.players.get(id);
    if (!player || !player.alive) return;
    // Queue up to 2 turns; validity against the actual heading is checked at
    // apply time, since earlier queued turns change it.
    const last = player.pendingDirs[player.pendingDirs.length - 1] ?? player.dir;
    if (dir === last || dir === OPPOSITE[last]) return;
    if (player.pendingDirs.length < 2) player.pendingDirs.push(dir);
  }

  private tick(): void {
    const now = Date.now();
    switch (this.phase) {
      case 'waiting':
        if (this.players.size >= 2) this.setPhase('countdown', now + COUNTDOWN_MS);
        break;
      case 'countdown':
        if (this.players.size < 2) this.setPhase('waiting', null);
        else if (this.phaseEndsAt !== null && now >= this.phaseEndsAt) this.startRound();
        break;
      case 'playing':
        this.simulate();
        break;
      case 'round_over':
        if (this.phaseEndsAt !== null && now >= this.phaseEndsAt) {
          this.setPhase(this.players.size >= 2 ? 'countdown' : 'waiting',
            this.players.size >= 2 ? Date.now() + COUNTDOWN_MS : null);
        }
        break;
    }
  }

  private startRound(): void {
    this.grid.clear();
    const roster = [...this.players.values()];
    const pattern = SPAWN_PATTERNS[Math.floor(this.round / ROUNDS_PER_PATTERN) % SPAWN_PATTERNS.length];
    this.round += 1;
    roster.forEach((p, i) => {
      p.spectating = false;
      p.alive = true;
      const s = this.spawn(pattern, i, roster.length);
      p.x = s.x;
      p.y = s.y;
      // Rounding can land two players on one cell; nudge until free.
      while (this.grid.has(this.cell(p.x, p.y))) p.x = (p.x + 1) % GRID_W;
      p.dir = s.dir;
      p.pendingDirs = [];
      p.trail = [[p.x, p.y]];
      this.grid.set(this.cell(p.x, p.y), p.id);
    });
    this.phase = 'playing';
    this.phaseEndsAt = null;
    this.broadcast(this.snapshot());
  }

  private spawn(pattern: SpawnPattern, i: number, n: number): { x: number; y: number; dir: Dir } {
    if (pattern === 'columns') {
      // Spread across columns; alternate top edge facing down / bottom edge facing up.
      return {
        x: Math.round((GRID_W * (i + 1)) / (n + 1)),
        y: i % 2 === 0 ? Math.round(GRID_H / 5) : Math.round((GRID_H * 4) / 5),
        dir: i % 2 === 0 ? 'down' : 'up',
      };
    }
    if (pattern === 'perimeter') {
      // Evenly spaced along an inset rectangle, facing inward.
      const m = 6;
      const w = GRID_W - 2 * m;
      const h = GRID_H - 2 * m;
      const d = (2 * (w + h) * i) / n;
      if (d < w) return { x: m + Math.round(d), y: m, dir: 'down' };
      if (d < w + h) return { x: GRID_W - m, y: m + Math.round(d - w), dir: 'left' };
      if (d < 2 * w + h) return { x: GRID_W - m - Math.round(d - w - h), y: GRID_H - m, dir: 'up' };
      return { x: m, y: GRID_H - m - Math.round(d - 2 * w - h), dir: 'right' };
    }
    // circle: evenly spaced on a ring, everyone facing tangentially — a swirl.
    const a = (2 * Math.PI * i) / n;
    const r = Math.min(GRID_W, GRID_H) / 3;
    const tx = Math.cos(a + Math.PI / 2);
    const ty = Math.sin(a + Math.PI / 2);
    return {
      x: Math.round(GRID_W / 2 + r * Math.cos(a)),
      y: Math.round(GRID_H / 2 + r * Math.sin(a)),
      dir: Math.abs(tx) > Math.abs(ty) ? (tx > 0 ? 'right' : 'left') : (ty > 0 ? 'down' : 'up'),
    };
  }

  private simulate(): void {
    const alive = [...this.players.values()].filter((p) => p.alive);

    // Everyone commits their move for this tick before collisions are judged,
    // so head-on collisions kill both players.
    const moves = alive.map((p) => {
      const next = p.pendingDirs.shift();
      if (next && next !== p.dir && next !== OPPOSITE[p.dir]) p.dir = next;
      const [dx, dy] = DELTA[p.dir];
      return { p, nx: p.x + dx, ny: p.y + dy };
    });

    const deaths: string[] = [];
    const inBounds = (x: number, y: number) => x >= 0 && x < GRID_W && y >= 0 && y < GRID_H;
    const targets = new Map<number, number>(); // cell -> movers into it
    for (const m of moves) {
      if (!inBounds(m.nx, m.ny)) continue; // OOB cell indices can alias real cells
      const c = this.cell(m.nx, m.ny);
      targets.set(c, (targets.get(c) ?? 0) + 1);
    }
    const survivors = moves.filter((m) => {
      const outOfBounds = !inBounds(m.nx, m.ny);
      const hitTrail = !outOfBounds && this.grid.has(this.cell(m.nx, m.ny));
      const headOn = !outOfBounds && targets.get(this.cell(m.nx, m.ny))! > 1;
      if (outOfBounds || hitTrail || headOn) {
        m.p.alive = false;
        deaths.push(m.p.id);
        return false;
      }
      return true;
    });

    for (const m of survivors) {
      m.p.x = m.nx;
      m.p.y = m.ny;
      m.p.trail.push([m.nx, m.ny]);
      this.grid.set(this.cell(m.nx, m.ny), m.p.id);
    }

    this.broadcast({
      t: 'tick',
      heads: survivors.map((m) => ({ id: m.p.id, x: m.nx, y: m.ny })),
      deaths,
    });

    const stillAlive = [...this.players.values()].filter((p) => p.alive);
    if (stillAlive.length <= 1) {
      const winner = stillAlive[0] ?? null;
      if (winner) winner.score += 1;
      this.phase = 'round_over';
      this.phaseEndsAt = Date.now() + ROUND_OVER_MS;
      this.broadcast({
        t: 'phase',
        phase: 'round_over',
        phaseEndsAt: this.phaseEndsAt,
        winner: winner ? this.info(winner) : null,
      });
    }
  }

  private setPhase(phase: Phase, endsAt: number | null): void {
    this.phase = phase;
    this.phaseEndsAt = endsAt;
    this.broadcast({ t: 'phase', phase, phaseEndsAt: endsAt, winner: null });
  }

  private cell(x: number, y: number): number {
    return y * GRID_W + x;
  }

  private info(p: Player): PlayerInfo {
    const { id, name, color, score, alive, spectating } = p;
    return { id, name, color, score, alive, spectating };
  }

  private state(p: Player): PlayerState {
    return { ...this.info(p), x: p.x, y: p.y, dir: p.dir, trail: p.trail };
  }

  private snapshot(): ServerMsg {
    return {
      t: 'snapshot',
      phase: this.phase,
      phaseEndsAt: this.phaseEndsAt,
      players: [...this.players.values()].map((p) => this.state(p)),
    };
  }

  private broadcastRoster(): void {
    this.broadcast({ t: 'roster', players: [...this.players.values()].map((p) => this.info(p)) });
  }

  private broadcast(msg: ServerMsg): void {
    for (const p of this.players.values()) p.client.send(msg);
  }
}
