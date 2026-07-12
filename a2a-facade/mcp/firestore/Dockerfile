# syntax=docker/dockerfile:1
FROM us-central1-docker.pkg.dev/database-toolbox/toolbox/toolbox:1.6.0@sha256:dffde9f4647826ec4e8c19ae46a45108cb18616aadcbdf45889dc1f3bc0c2cd7

COPY a2a-facade/mcp/firestore/tools.yaml /config/tools.yaml

EXPOSE 8003
ENTRYPOINT ["/toolbox", "--tools-file", "/config/tools.yaml", "--address", "0.0.0.0", "--port", "8003"]
