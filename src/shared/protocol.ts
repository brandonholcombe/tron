// Wire protocol and game constants shared by server and client.

export const GRID_W = 80;
export const GRID_H = 60;
export const TICK_MS = 66; // ~15 Hz
export const COUNTDOWN_MS = 3000;
export const ROUND_OVER_MS = 4000;
export const MAX_NAME_LEN = 16;

export type Dir = 'up' | 'down' | 'left' | 'right';

export const OPPOSITE: Record<Dir, Dir> = {
  up: 'down',
  down: 'up',
  left: 'right',
  right: 'left',
};

export const DELTA: Record<Dir, [number, number]> = {
  up: [0, -1],
  down: [0, 1],
  left: [-1, 0],
  right: [1, 0],
};

export type Phase = 'waiting' | 'countdown' | 'playing' | 'round_over';

export interface PlayerInfo {
  id: string;
  name: string;
  color: string;
  score: number;
  alive: boolean;
  spectating: boolean; // joined mid-round, in until next round
}

export interface PlayerState extends PlayerInfo {
  x: number;
  y: number;
  dir: Dir;
  trail: [number, number][]; // occupied cells including head
}

// client -> server
export type ClientMsg =
  | { t: 'join'; name: string }
  | { t: 'turn'; dir: Dir };

// server -> client
export type ServerMsg =
  | { t: 'welcome'; id: string }
  | { t: 'snapshot'; phase: Phase; phaseEndsAt: number | null; players: PlayerState[] }
  | { t: 'tick'; heads: { id: string; x: number; y: number }[]; deaths: string[] }
  | { t: 'phase'; phase: Phase; phaseEndsAt: number | null; winner: PlayerInfo | null }
  | { t: 'roster'; players: PlayerInfo[] };
