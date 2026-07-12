# syntax=docker/dockerfile:1
FROM node:22-slim@sha256:53ada149d435c38b14476cb57e4a7da73c15595aba79bd6971b547ceb6d018bf

RUN npm install -g --no-audit --no-fund supergateway@3.4.3 @google-cloud/observability-mcp@0.2.3

RUN useradd --create-home --uid 10001 mcp
USER mcp
ENV HOME=/home/mcp

EXPOSE 8002
CMD ["supergateway", "--outputTransport", "streamableHttp", "--port", "8002", "--stdio", "observability-mcp"]
