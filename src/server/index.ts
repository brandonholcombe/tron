import http from 'http';
import path from 'path';
import crypto from 'crypto';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { Game } from './game';
import { ClientMsg, ServerMsg, MAX_NAME_LEN } from '../shared/protocol';

const PORT = Number(process.env.PORT ?? 3000);
const app = express();

app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.use(express.static(path.resolve(process.cwd(), 'dist/public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const game = new Game();
game.start();

const VALID_DIRS = new Set(['up', 'down', 'left', 'right']);

wss.on('connection', (ws: WebSocket, req) => {
  req.socket.setNoDelay(true); // don't let Nagle batch tiny turn/tick frames
  const id = crypto.randomUUID().slice(0, 8);
  let joined = false;

  ws.on('message', (data) => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg.t === 'join' && !joined && typeof msg.name === 'string') {
      joined = true;
      const name = msg.name.trim().slice(0, MAX_NAME_LEN) || 'anon';
      game.addPlayer(id, name, {
        send: (m: ServerMsg) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
        },
      });
    } else if (msg.t === 'turn' && joined && VALID_DIRS.has(msg.dir)) {
      game.turn(id, msg.dir);
    }
  });

  ws.on('close', () => {
    if (joined) game.removePlayer(id);
  });
  ws.on('error', () => ws.close());
});

server.listen(PORT, () => {
  console.log(`tron server listening on :${PORT}`);
});
