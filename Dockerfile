# syntax=docker/dockerfile:1.7-labs
###############################################################################
# NgodeAI — ngodeai image
#
# Stages:
#   natives-builder — Rust + Bun → ngode_natives.linux-<arch>.node
#   wheel-builder   — ngodeai_rpc Python wheel
#   ngodeai-base    — python + bun + rustup launcher + natives + ngodeai_rpc
#                     + /usr/local/bin/ngodeai shim
#   ngodeai-runtime — ngodeai-base + source + bun install    (DEFAULT, runnable)
#
# Build:
#     docker build -t ngodeai/ngodeai:dev .                      # default = ngodeai-runtime
#     docker build --target ngodeai-base -t ngodeai/ngodeai-base:dev .  # base for derived images
#
# Run:
#     docker run --rm ngodeai/ngodeai:dev --help
#     docker run --rm -it -v "$PWD":/work ngodeai/ngodeai:dev cli  # interactive ngodeai
#
# Consume as a base in another Dockerfile (see Dockerfile.ngodebot):
#     ARG NGODEAI_BASE=ngodeai/ngodeai:dev
#     FROM ${NGODEAI_BASE} AS ngodeai-base
###############################################################################

ARG BUN_VERSION=1.4.3

############################
# 1) natives-builder — Rust + Bun → ngode_natives.linux-<arch>.node (local cargo)
############################
FROM rust:1.86-slim-bookworm AS natives-builder

ARG BUN_VERSION

# The addon is built with the default cargo/napi-rs host backend, not Bazel:
# the image is one fixed host target, so Bazel's hermetic cross toolchains
# and crate_universe splice buy nothing while costing a bazelisk download
# plus a full analysis phase on every build. `ci` profile = release codegen,
# thin LTO, stripped.
ENV BUN_INSTALL=/opt/bun \
    PATH=/opt/bun/bin:/usr/local/cargo/bin:/usr/local/bin:/usr/bin:/bin \
    CARGO_TERM_COLOR=never \
    NGODEAI_NATIVE_CARGO_PROFILE=ci

# clang/libclang-dev: bindgen for pipewire-sys/libspa-sys (Linux desktop capture);
# cmake/make/ninja-build: opusic-sys builds bundled libopus via CMake.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        curl ca-certificates pkg-config libssl-dev unzip git \
        clang libclang-dev cmake make ninja-build \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" \
    && /opt/bun/bin/bun --version

WORKDIR /pi

# Layer 0 — the pinned nightly toolchain. Its own layer so a source or manifest
# edit never re-downloads ~5 rustup components.
COPY rust-toolchain.toml /pi/
RUN rustup show

# Layer 1 — manifests + lockfiles only. Source edits under packages/*/src and
# crates/*/src won't bust `bun install` below. `--parents` preserves the
# matched path under /pi/ (requires syntax 1.7-labs).
COPY --parents \
    package.json bun.lock bunfig.toml \
    patches/*.patch \
    tsconfig.base.json tsconfig.json \
    Cargo.toml Cargo.lock rust-toolchain.toml \
    packages/*/package.json \
    packages/tsconfig.workspace.json \
    python/ngodebot/web/package.json \
    crates/*/Cargo.toml \
    /pi/

# Layer 2 — hydrate node_modules from the manifests above.
RUN bun install --frozen-lockfile --ignore-scripts

# Layer 3 — full source. `Dockerfile.dockerignore` keeps target/, node_modules/,
# dist/, runs/, editor noise, etc. out of the context. node_modules from Layer 2
# is preserved across this COPY because it's never in the build context.
COPY . /pi/

# Layer 4 — compile ngode-natives to a Linux N-API addon. Persistent caches keep
# repeat builds incremental: cargo's package index + git-deps (CARGO_HOME is
# /usr/local/cargo in the rust image, not ~/.cargo) + the workspace target dir.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/pi/target \
    set -eux; \
    bun --cwd=packages/natives run build; \
    mkdir -p /out; \
    cp packages/natives/native/ngode_natives.linux-*.node /out/

############################
# 2) wheel-builder — ngodeai-rpc wheel
############################
FROM python:3.12-slim-bookworm AS wheel-builder

RUN apt-get update \
    && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --upgrade pip build

WORKDIR /src
COPY sdk/python/ngodeai-rpc /src
RUN python -m build --wheel --outdir /out

############################
# 3) ngodeai-base — python + bun + rustup + natives + ngodeai_rpc + ngodeai shim
#
# Sharable runtime base. Derived images (pi-runtime below, Dockerfile.ngodebot)
# extend this and overlay their own source tree. Default NGODEAI_ROOT=/work/pi is
# friendly to derived images that mount a host pi checkout there; pi-runtime
# overrides it to /pi because its source is baked in.
############################
FROM python:3.12-slim-bookworm AS ngodeai-base

ARG BUN_VERSION
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    BUN_INSTALL=/opt/bun \
    NGODEAI_ROOT=/work/pi \
    CARGO_HOME=/data/cache/cargo \
    CARGO_TARGET_DIR=/data/cache/cargo-target \
    RUSTUP_HOME=/data/cache/rustup \
    PATH=/opt/bun/bin:/usr/local/cargo/bin:/usr/local/bin:/usr/bin:/bin:/usr/local/bun-node-fallback-bin

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        git curl ca-certificates unzip openssh-client tini sqlite3 \
        build-essential pkg-config libssl-dev \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" \
    && /opt/bun/bin/bun --version

# `node` → bun, last on PATH (same layout as the oven/bun images) so
# `#!/usr/bin/env node` package bins (oxlint, oxfmt, …) run for every uid.
# Bun's own fallback is a /tmp/bun-node-<hash> dir created 0700 by the first
# user that needs it; the image build runs as root, so it would bake a dir
# no ngodebot slot user can enter.
RUN mkdir -p /usr/local/bun-node-fallback-bin \
    && ln -s /opt/bun/bin/bun /usr/local/bun-node-fallback-bin/node

# Rustup launcher only — the real toolchain is fetched lazily into RUSTUP_HOME
# on first cargo invocation, driven by pi's `rust-toolchain.toml`. Keeps the
# image small while sharing the toolchain across reboots when /data is mounted.
RUN curl -fsSL https://sh.rustup.rs -o /tmp/rustup-init.sh \
    && CARGO_HOME=/usr/local/cargo RUSTUP_HOME=/usr/local/rustup-bootstrap \
       sh /tmp/rustup-init.sh -y --no-modify-path --default-toolchain none --profile minimal \
    && rm -f /tmp/rustup-init.sh \
    && rm -rf /usr/local/rustup-bootstrap \
    && /usr/local/cargo/bin/rustup --version

# ngode-natives addon: pi's loader probes /opt/bun/bin as a fallback path.
COPY --from=natives-builder /out/ngode_natives.linux-*.node /opt/bun/bin/

# ngodeai-rpc Python wheel.
COPY --from=wheel-builder /out/*.whl /tmp/wheels/
RUN pip install /tmp/wheels/ngodeai_rpc-*.whl && rm -rf /tmp/wheels

# Legal payload for the reusable SDKs and the NGODEAI product installed in this image.
COPY LICENSE  THIRD-PARTY-NOTICES.txt /usr/share/doc/ngodeai/

# `ngodeai` shim — runs the coding-agent CLI against $NGODEAI_ROOT via Bun. Derived
# images override NGODEAI_ROOT to point at wherever their source lives.
RUN printf '%s\n' \
    '#!/usr/bin/env bash' \
    'set -euo pipefail' \
    ': "${NGODEAI_ROOT:=/work/ngodeai}"' \
    'if [ ! -d "$NGODEAI_ROOT/packages/coding-agent" ]; then' \
    '  echo "ngodeai: NGODEAI_ROOT=$NGODEAI_ROOT does not look like a NgodeAI checkout" >&2' \
    '  exit 127' \
    'fi' \
    'exec bun "$NGODEAI_ROOT/packages/coding-agent/src/cli.ts" "$@"' \
    > /usr/local/bin/ngodeai \
    && chmod +x /usr/local/bin/ngodeai

############################
# 4) ngodeai-runtime — ngodeai-base + source + bun install (DEFAULT)
#
# A self-contained, runnable ngodeai image. `docker run ngodeai/ngodeai:dev --help`
# Just Works without a host checkout.
############################
FROM ngodeai-base AS ngodeai-runtime

ENV NGODEAI_ROOT=/pi
WORKDIR /pi

# Same manifests-only layered install pattern as natives-builder — `bun install`
# only re-runs when a package.json / lockfile changes.
COPY --parents \
    package.json bun.lock bunfig.toml \
    patches/*.patch \
    tsconfig.base.json tsconfig.json \
    packages/*/package.json \
    packages/tsconfig.workspace.json \
    python/ngodebot/web/package.json \
    /pi/

RUN bun install --frozen-lockfile --ignore-scripts

# NgodeAI source. `Dockerfile.dockerignore` keeps **/node_modules out of the context
# so stale isolated-linker symlinks from a host install can't shadow the
# hoisted node_modules that `bun install` just produced.
COPY . /pi/

# Regenerate the tool views that `--ignore-scripts` skipped above. The root
# package.json's `prepare` script normally handles these on a vanilla install.
RUN bun --cwd=packages/coding-agent run gen:tool-views

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/ngodeai"]
CMD ["--help"]
