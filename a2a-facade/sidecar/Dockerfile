# syntax=docker/dockerfile:1
FROM robustadev/holmes:0.35.0@sha256:5c89c75225b0e29df1290943d275e84563dc0058f43bc9ac2baf10f06dc3ed79

# serverless 非互換ヘルスチェックのパッチ (ADR-0069 Phase 0.5 バグ①。upstream 修正までの fork ビルド)
RUN sed -i 's|self._make_request("GET", "_cluster/health", timeout=10)|self._make_request("GET", "_resolve/index/*", timeout=10)|' \
      /app/holmes/plugins/toolsets/elasticsearch/elasticsearch.py \
 && grep -q '_resolve/index/\*' /app/holmes/plugins/toolsets/elasticsearch/elasticsearch.py

COPY a2a-facade/sidecar/entrypoint.py /app/sidecar_entrypoint.py

RUN useradd --create-home --uid 10001 holmes
USER holmes
ENV HOME=/home/holmes

EXPOSE 8081
ENTRYPOINT ["python", "/app/sidecar_entrypoint.py"]
