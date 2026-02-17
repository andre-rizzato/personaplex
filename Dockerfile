ARG BASE_IMAGE="nvcr.io/nvidia/cuda"
ARG BASE_IMAGE_TAG="12.4.1-runtime-ubuntu22.04"

FROM node:20-slim AS client-build
WORKDIR /app/client
COPY client/package.json client/package-lock.json* ./
RUN npm install
COPY client/ ./
RUN npm run build

FROM ${BASE_IMAGE}:${BASE_IMAGE_TAG} AS base

COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    pkg-config \
    libopus-dev \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app/moshi/

COPY moshi/ /app/moshi/
RUN uv venv /app/moshi/.venv --python 3.12
RUN uv sync
RUN mkdir -p /app/ssl

COPY --from=client-build /app/client/dist /app/client-dist

EXPOSE 8998

ENTRYPOINT []
CMD ["/app/moshi/.venv/bin/python", "-m", "moshi.server", "--ssl", "/app/ssl", "--host", "0.0.0.0", "--device", "cpu", "--static", "/app/client-dist"]
