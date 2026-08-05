FROM oven/bun:1 as base
WORKDIR /app

COPY . .

RUN mkdir -p /app/data

ENV PORT=8080
EXPOSE 8080

CMD ["bun", "run", "server.ts"]
