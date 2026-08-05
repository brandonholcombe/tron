import {
  GRID_W, GRID_H, TICK_MS, DELTA, OPPOSITE, Dir, Phase, PlayerInfo, ServerMsg, ClientMsg,
} from '../shared/protocol';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const hud = document.getElementById('hud')!;
const banner = document.getElementById('banner')!;
const joinOverlay = document.getElementById('join')!;
const nameInput = document.getElementById('name') as HTMLInputElement;
const goButton = document.getElementById('go')!;

let ws: WebSocket | null = null;
let myId = '';
let myName = '';
let phase: Phase = 'waiting';
let phaseEndsAt: number | null = null;
let winner: PlayerInfo | null = null;
const players = new Map<string, PlayerInfo>();
const trails = new Map<string, [number, number][]>();
const dirs = new Map<string, Dir>(); // confirmed heading, derived from server ticks
let lastTickAt = performance.now();
let predictedDir: Dir | null = null; // own turn rendered before the server confirms it

function connect(): void {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => send({ t: 'join', name: myName });
  ws.onmessage = (ev) => handle(JSON.parse(ev.data) as ServerMsg);
  ws.onclose = () => {
    banner.textContent = 'RECONNECTING…';
    banner.style.color = '#ff5252';
    setTimeout(connect, 1500);
  };
}

function send(msg: ClientMsg): void {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function handle(msg: ServerMsg): void {
  switch (msg.t) {
    case 'welcome':
      myId = msg.id;
      break;
    case 'snapshot':
      phase = msg.phase;
      phaseEndsAt = msg.phaseEndsAt;
      winner = null;
      players.clear();
      trails.clear();
      dirs.clear();
      predictedDir = null;
      lastTickAt = performance.now();
      for (const p of msg.players) {
        players.set(p.id, p);
        trails.set(p.id, [...p.trail]);
        dirs.set(p.id, p.dir);
      }
      break;
    case 'tick':
      lastTickAt = performance.now();
      for (const h of msg.heads) {
        const trail = trails.get(h.id);
        if (!trail) continue;
        const prev = trail[trail.length - 1];
        if (prev) {
          if (h.x > prev[0]) dirs.set(h.id, 'right');
          else if (h.x < prev[0]) dirs.set(h.id, 'left');
          else if (h.y > prev[1]) dirs.set(h.id, 'down');
          else if (h.y < prev[1]) dirs.set(h.id, 'up');
        }
        trail.push([h.x, h.y]);
      }
      for (const id of msg.deaths) {
        const p = players.get(id);
        if (p) p.alive = false;
      }
      // Drop the prediction once the server confirms it — or has clearly
      // rejected it (a 180 relative to the confirmed heading).
      if (predictedDir) {
        const confirmed = dirs.get(myId);
        if (confirmed && (confirmed === predictedDir || predictedDir === OPPOSITE[confirmed])) {
          predictedDir = null;
        }
      }
      break;
    case 'phase':
      phase = msg.phase;
      phaseEndsAt = msg.phaseEndsAt;
      winner = msg.winner;
      if (msg.winner) {
        const p = players.get(msg.winner.id);
        if (p) p.score = msg.winner.score;
      }
      break;
    case 'roster': {
      const seen = new Set<string>();
      for (const info of msg.players) {
        seen.add(info.id);
        const existing = players.get(info.id);
        if (existing) Object.assign(existing, info);
        else players.set(info.id, info);
      }
      for (const id of [...players.keys()]) {
        if (!seen.has(id)) {
          players.delete(id);
          // their trail stays on screen until next snapshot, like the server grid
        }
      }
      break;
    }
  }
}

const KEYS: Record<string, Dir> = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  w: 'up', s: 'down', a: 'left', d: 'right',
  W: 'up', S: 'down', A: 'left', D: 'right',
};
window.addEventListener('keydown', (e) => {
  if (!ws || e.target instanceof HTMLInputElement) return; // typing name, not steering
  const dir = KEYS[e.key];
  if (dir) {
    e.preventDefault();
    send({ t: 'turn', dir });
    // Optimistically show the turn right away; the server confirms next tick.
    const me = players.get(myId);
    const heading = predictedDir ?? dirs.get(myId);
    if (me?.alive && phase === 'playing' && heading && dir !== heading && dir !== OPPOSITE[heading]) {
      predictedDir = dir;
    }
  }
});

function resize(): void {
  const cell = Math.max(4, Math.floor(Math.min(
    (window.innerWidth - 20) / GRID_W,
    (window.innerHeight - 20) / GRID_H,
  )));
  canvas.width = GRID_W * cell;
  canvas.height = GRID_H * cell;
}
window.addEventListener('resize', resize);
resize();

function draw(): void {
  const cell = canvas.width / GRID_W;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  ctx.strokeStyle = 'rgba(0, 229, 255, 0.06)';
  ctx.lineWidth = 1;
  for (let x = 0; x <= GRID_W; x += 10) {
    ctx.beginPath(); ctx.moveTo(x * cell, 0); ctx.lineTo(x * cell, canvas.height); ctx.stroke();
  }
  for (let y = 0; y <= GRID_H; y += 10) {
    ctx.beginPath(); ctx.moveTo(0, y * cell); ctx.lineTo(canvas.width, y * cell); ctx.stroke();
  }

  // Fraction of the current tick elapsed — heads glide between cells instead
  // of snapping at 15 Hz.
  const progress = phase === 'playing'
    ? Math.min(1, (performance.now() - lastTickAt) / TICK_MS)
    : 0;

  for (const [id, trail] of trails) {
    const p = players.get(id);
    const color = p?.color ?? '#446677';
    ctx.fillStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 6;
    for (const [x, y] of trail) ctx.fillRect(x * cell, y * cell, cell, cell);
    const head = trail[trail.length - 1];
    if (head && p?.alive) {
      const dir = (id === myId && predictedDir) ? predictedDir : dirs.get(id);
      const [dx, dy] = dir ? DELTA[dir] : [0, 0];
      ctx.fillRect((head[0] + dx * progress) * cell, (head[1] + dy * progress) * cell, cell, cell);
      ctx.shadowBlur = 14;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect((head[0] + dx * progress) * cell, (head[1] + dy * progress) * cell, cell, cell);
    }
    ctx.shadowBlur = 0;
  }

  updateHud();
  requestAnimationFrame(draw);
}

function updateHud(): void {
  hud.innerHTML = [...players.values()]
    .sort((a, b) => b.score - a.score)
    .map((p) => {
      const you = p.id === myId ? ' ◄' : '';
      const state = p.spectating ? ' (spectating)' : p.alive || phase !== 'playing' ? '' : ' ✕';
      return `<div style="color:${p.color}">${escapeHtml(p.name)} — ${p.score}${state}${you}</div>`;
    })
    .join('');

  banner.style.color = '#00e5ff';
  if (phase === 'waiting') {
    banner.textContent = players.size < 2 ? 'WAITING FOR OPPONENTS…' : '';
  } else if (phase === 'countdown' && phaseEndsAt) {
    const s = Math.max(0, Math.ceil((phaseEndsAt - Date.now()) / 1000));
    banner.textContent = `ROUND STARTS IN ${s}`;
  } else if (phase === 'round_over') {
    if (winner) {
      banner.style.color = winner.color;
      banner.textContent = `${winner.name.toUpperCase()} WINS THE ROUND`;
    } else {
      banner.textContent = 'MUTUAL DERESOLUTION';
    }
  } else {
    const me = players.get(myId);
    banner.textContent = me?.spectating ? 'SPECTATING — NEXT ROUND SOON' : '';
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

goButton.addEventListener('click', join);
nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
nameInput.value = localStorage.getItem('tron-name') ?? '';

function join(): void {
  myName = nameInput.value.trim() || 'anon';
  localStorage.setItem('tron-name', myName);
  joinOverlay.style.display = 'none';
  connect();
}

draw();
