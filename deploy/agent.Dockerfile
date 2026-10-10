# The stock agent (apps/agent) and the Binance Agentic Wallet CLI (`baw`). Build context: the repo root.
# Never started by `up`: run one-off with `docker compose … run --rm agent …` (see deploy/README.md).
FROM node:22-slim
RUN npm install --global @binance/agentic-wallet@1.10.0 && corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY scripts/only-pnpm.cjs scripts/
COPY packages/core/package.json packages/core/
COPY apps/agent/package.json apps/agent/
RUN pnpm install --frozen-lockfile
COPY packages/core packages/core
COPY apps/agent apps/agent
ENTRYPOINT ["pnpm", "agent"]
