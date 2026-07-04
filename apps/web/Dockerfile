# syntax=docker/dockerfile:1
FROM node:25-slim@sha256:81db02c4b671288a03915da9534dbd54f96d0e7c24d80ccc54f5b36b2e684370 AS deps
WORKDIR /app
# lockfile も渡して再現性のある高速インストール (npm ci)。
# BuildKit キャッシュマウントで ~/.npm を再ビルド間で再利用する。
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

FROM node:25-slim@sha256:81db02c4b671288a03915da9534dbd54f96d0e7c24d80ccc54f5b36b2e684370 AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# NEXT_PUBLIC_* はビルド時にバンドルへ焼き込まれるため、ビルド引数として受け取る。
# 既定はローカル開発のブラウザから見たエンドポイント。本番は CI でビルド引数を上書きする。
ARG NEXT_PUBLIC_API_URL=http://localhost:8080
ARG NEXT_PUBLIC_LIVEKIT_URL=ws://localhost:7880
ARG NEXT_PUBLIC_RETENTION_DAYS=30
# Google ログイン (ADR-0012)。空ビルドは dev モード (ログインボタンを出さない)。
ARG NEXT_PUBLIC_GOOGLE_CLIENT_ID=
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_LIVEKIT_URL=$NEXT_PUBLIC_LIVEKIT_URL \
    NEXT_PUBLIC_RETENTION_DAYS=$NEXT_PUBLIC_RETENTION_DAYS \
    NEXT_PUBLIC_GOOGLE_CLIENT_ID=$NEXT_PUBLIC_GOOGLE_CLIENT_ID
RUN npm run build

FROM node:25-slim@sha256:81db02c4b671288a03915da9534dbd54f96d0e7c24d80ccc54f5b36b2e684370 AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
# node:* images ship an unprivileged "node" user; run as it (defense in depth).
USER node
EXPOSE 3000
CMD ["sh", "-c", "node server.js"]
