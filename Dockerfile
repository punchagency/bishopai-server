# Stage 1: Build TypeScript app
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig*.json ./
COPY src ./src
COPY migrations ./migrations
COPY assets ./assets

RUN npm run build

# Stage 2: Production image
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/migrations ./migrations
# Nicole's own document templates (ROF/Supplement/Flow Sheet). Without these
# publishClientTemplates throws on every approval and no client-facing doc
# reaches Drive — the Markdown exports succeed, hiding the failure.
COPY --from=builder /app/assets ./assets

EXPOSE 3000

CMD ["npm", "start"]
