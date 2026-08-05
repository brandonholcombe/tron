# tron

Multiplayer light-cycles in the browser — https://tron.kodloki.io

Everyone who connects joins one shared arena. Rounds start when two or more
players are present; last cycle alive wins the round. Arrows or WASD to turn.

## Run locally

```bash
npm install
npm run dev     # http://localhost:3000 — open two tabs to start a round
```

## Deploy

```bash
scripts/deploy.sh   # build + push image, bump tag, git push; ArgoCD syncs
```

See `CLAUDE.md` for architecture and cluster details.
