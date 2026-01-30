FROM node:20-slim

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . ./

# Build client dist
RUN pnpm run build:dist

ENV NODE_ENV=production
ENV SERVER_PORT=7245

EXPOSE 7245

CMD ["pnpm", "run", "dist:start"]
