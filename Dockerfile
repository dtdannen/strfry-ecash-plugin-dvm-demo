FROM rust:1.83-slim AS builder

WORKDIR /build

# Install build dependencies
RUN apt-get update && apt-get install -y \
    git \
    pkg-config \
    libssl-dev \
    protobuf-compiler \
    && rm -rf /var/lib/apt/lists/*

# Copy the local modified CDK repository
COPY ./cdk /build/cdk

WORKDIR /build/cdk

# Build cdk-mintd with fakewallet and postgres features
RUN cargo build --release --package cdk-mintd --features "fakewallet postgres"

# Runtime stage
FROM debian:bookworm-slim

# Install runtime dependencies
RUN apt-get update && apt-get install -y \
    ca-certificates \
    libssl3 \
    && rm -rf /var/lib/apt/lists/*

# Copy the binary from builder
COPY --from=builder /build/cdk/target/release/cdk-mintd /usr/local/bin/cdk-mintd

# Create config directory
RUN mkdir -p /root/.cdk-mintd

# Expose the default port
EXPOSE 8085

CMD ["cdk-mintd"]
