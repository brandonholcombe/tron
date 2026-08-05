#!/usr/bin/env bash
# Build, push, and roll out a new tron image via GitOps.
# Usage: scripts/deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."

SHA=$(git rev-parse --short=7 HEAD)
IMAGE="bholcombe/tron-server"
TAG="sha-${SHA}"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "error: working tree is dirty — commit first so the image tag matches the code" >&2
  exit 1
fi

echo "==> building ${IMAGE}:${TAG}"
docker buildx build --platform linux/amd64 \
  -t "${IMAGE}:${TAG}" -t "${IMAGE}:latest" \
  --push .

echo "==> updating K8s/deployment.yaml to ${TAG}"
sed -i '' "s|image: ${IMAGE}:.*|image: ${IMAGE}:${TAG}|" K8s/deployment.yaml

if git diff --quiet K8s/deployment.yaml; then
  echo "==> image tag unchanged, nothing to commit"
  exit 0
fi

git add K8s/deployment.yaml
git commit -m "deploy: ${IMAGE}:${TAG}

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"

echo "==> pushing (github canonical, gitea mirror)"
git push github HEAD
git push gitea HEAD || echo "warning: gitea mirror push failed (non-fatal)"

echo "==> done — ArgoCD will sync the new tag from GitHub"
