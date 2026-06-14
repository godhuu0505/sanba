# ADK agent on Cloud Run.
FROM python:3.13-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PORT=8080

WORKDIR /app

# Install dependencies first for better layer caching.
COPY requirements.txt ./
RUN pip install -r requirements.txt

# App code.
COPY main.py ./
COPY interviewer ./interviewer

# Run as non-root.
RUN useradd --system --uid 1001 appuser && chown -R appuser /app
USER appuser

EXPOSE 8080
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT}"]
