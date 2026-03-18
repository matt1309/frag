# ── Build stage ───────────────────────────────────────────────────────────────
FROM debian:bookworm-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential cmake libsqlite3-dev ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY . .

RUN cmake -B build -DCMAKE_BUILD_TYPE=Release \
    && cmake --build build --parallel "$(nproc)"

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM debian:bookworm-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
        libsqlite3-0 \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -r -s /bin/false fraguser
WORKDIR /app

COPY --from=builder /src/build/frag-server .
COPY config.example.json config.json

RUN chown -R fraguser:fraguser /app
USER fraguser

EXPOSE 8080
VOLUME ["/app"]

ENTRYPOINT ["./frag-server", "-c", "config.json"]
