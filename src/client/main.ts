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

// Trails are drawn incrementally onto an offscreen canvas and blitted each
// frame — redrawing thousands of glowing cells per frame is what janks Canvas.
const trailCanvas = document.createElement('canvas');
const trailCtx = trailCanvas.getContext('2d')!;
const trailDrawn = new Map<string, number>(); // cells already painted per player

function resetTrailCanvas(): void {
  trailCanvas.width = canvas.width;
  trailCanvas.height = canvas.height;
  trailCtx.clearRect(0, 0, trailCanvas.width, trailCanvas.height);
  trailDrawn.clear();
}
const dirs = new Map<string, Dir>(); // confirmed heading, derived from server ticks
let predictedDir: Dir | null = null; // own turn rendered before the server confirms it

// Smoothed render clock: heads are drawn at a position along the trail indexed
// by `renderTick`, which advances on the local clock and is only *nudged*
// toward the server's tick count — so network jitter never causes visible pops.
let ticksSeen = 0;
let renderTick = 0;
let lastFrameAt = performance.now();
let hudNextAt = 0;

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
      ticksSeen = 0;
      renderTick = 0;
      resetTrailCanvas();
      for (const p of msg.players) {
        players.set(p.id, p);
        trails.set(p.id, [...p.trail]);
        dirs.set(p.id, p.dir);
      }
      break;
    case 'tick':
      ticksSeen += 1;
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
  resetTrailCanvas();
}
window.addEventListener('resize', resize);
resize();

function draw(frameNow: number): void {
  const dt = Math.min(100, frameNow - lastFrameAt);
  lastFrameAt = frameNow;
  if (phase === 'playing') {
    renderTick += dt / TICK_MS; // advance on the steady local clock
    renderTick += (ticksSeen - renderTick) * 0.08; // gently chase the server
    renderTick = Math.max(ticksSeen - 2, Math.min(ticksSeen + 1, renderTick));
  } else {
    renderTick = ticksSeen;
  }

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

  // Paint only newly-arrived trail cells onto the offscreen layer.
  for (const [id, trail] of trails) {
    let done = trailDrawn.get(id) ?? 0;
    if (done >= trail.length) continue;
    const color = players.get(id)?.color ?? '#446677';
    trailCtx.fillStyle = color;
    trailCtx.shadowColor = color;
    trailCtx.shadowBlur = 6;
    for (; done < trail.length; done++) {
      const [x, y] = trail[done];
      trailCtx.fillRect(x * cell, y * cell, cell, cell);
    }
    trailCtx.shadowBlur = 0;
    trailDrawn.set(id, done);
  }
  ctx.drawImage(trailCanvas, 0, 0);

  for (const [id, trail] of trails) {
    const p = players.get(id);
    if (p?.alive && trail.length > 0) {
      const [hx, hy] = headPos(id, trail);
      ctx.fillStyle = p.color;
      ctx.shadowColor = p.color;
      ctx.shadowBlur = 14;
      ctx.fillRect(hx * cell, hy * cell, cell, cell);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(hx * cell, hy * cell, cell, cell);
      ctx.shadowBlur = 0;
    }
  }

  if (frameNow >= hudNextAt) {
    updateHud();
    hudNextAt = frameNow + 150; // innerHTML churn every frame causes jank
  }
  requestAnimationFrame(draw);
}

// Continuous head position along the trail path at `renderTick`; positions
// past the newest confirmed cell extrapolate along the current (or, for our
// own cycle, optimistically predicted) heading.
function headPos(id: string, trail: [number, number][]): [number, number] {
  const last = trail.length - 1;
  const idxF = Math.max(0, last + (renderTick - ticksSeen));
  const i0 = Math.min(Math.floor(idxF), last);
  const f = idxF - i0;
  const c0 = trail[i0];
  let c1: [number, number];
  if (i0 + 1 <= last) {
    c1 = trail[i0 + 1];
  } else {
    const dir = (id === myId && predictedDir) ? predictedDir : dirs.get(id);
    const [dx, dy] = dir ? DELTA[dir] : [0, 0];
    c1 = [c0[0] + dx, c0[1] + dy];
  }
  return [c0[0] + (c1[0] - c0[0]) * f, c0[1] + (c1[1] - c0[1]) * f];
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

requestAnimationFrame(draw);
