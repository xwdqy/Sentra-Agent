FROM node:20-slim

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml ./

RUN pnpm install --frozen-lockfile

COPY . ./

ENV NODE_ENV=production

RUN pnpm build

CMD ["node", "dist/Main.js"]
