# Daybook: agent-first personal budgeting.
# Build:  docker build -t daybook .
# Run:    docker run -d --name daybook -p 3111:3111 -v daybook-data:/data daybook
# Open:   http://localhost:3111
# The SQLite database lives at /data/budget.db inside the named volume,
# so it survives container rebuilds. Override with -e BUDGET_DB=/path.

FROM oven/bun:1 AS build
WORKDIR /app

# Server deps
COPY package.json bun.lock ./
RUN bun install

# Client deps + build
COPY client/package.json client/bun.lock ./client/
RUN cd client && bun install
COPY client ./client
RUN cd client && bun run build

FROM oven/bun:1-slim
WORKDIR /app

COPY --from=build /app/package.json /app/bun.lock ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/src ./src
COPY --from=build /app/client/dist ./client/dist

ENV PORT=3111
ENV BUDGET_DB=/data/budget.db
EXPOSE 3111
VOLUME /data

CMD ["bun", "src/cli.ts", "serve"]
