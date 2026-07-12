# syntax=docker/dockerfile:1
FROM node:22-slim@sha256:53ada149d435c38b14476cb57e4a7da73c15595aba79bd6971b547ceb6d018bf

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
ENV PATH="/app/node_modules/.bin:${PATH}"

RUN useradd --create-home --uid 10001 mcp
USER mcp
ENV HOME=/home/mcp

EXPOSE 8002
CMD ["supergateway", "--outputTransport", "streamableHttp", "--port", "8002", "--stdio", "observability-mcp"]
