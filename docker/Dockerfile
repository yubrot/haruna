FROM debian:bookworm-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends curl ca-certificates git build-essential && \
    rm -rf /var/lib/apt/lists/*

# Non-root user (entrypoint runs as root, then drops to this user)
ENV USER_NAME=haruna
ARG USER_UID=1000
ARG USER_GID=1000
RUN groupadd -g ${USER_GID} ${USER_NAME} && \
    useradd -m -u ${USER_UID} -g ${USER_GID} -s /bin/bash ${USER_NAME}

ENV PATH="/home/${USER_NAME}/.local/bin:/home/${USER_NAME}/.local/share/mise/shims:$PATH"

# This image is intentionally kept nearly static.
# Tools (mise, Claude Code) and project dependencies (bun, node_modules) are
# installed by entrypoint.sh into a named volume (~/.local or node_modules), so
# that `mise upgrade`, `claude update`, etc. persist across container restarts
# without rebuilding the image.

# ------ WE DON'T DO HERE (BEGIN) ------
# USER ${USER_NAME}
#
# RUN curl https://mise.run | sh
# RUN curl -fsSL https://claude.ai/install.sh | bash
#
# # Install project dependencies
# # Actual working directory is bind-mounted at the host path via compose.yml.
# # /tmp/workdir is only used here to warm the bun cache during build.
# WORKDIR /tmp/workdir
# COPY --chown=${USER_NAME}:${USER_NAME} mise.toml ./
# RUN mise trust && mise install
# COPY --chown=${USER_NAME}:${USER_NAME} package.json bun.lock ./
# RUN bun install --frozen-lockfile
#
# USER root
# ------ WE DON'T DO HERE (END) ------

COPY --chmod=755 docker/entrypoint.sh /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
CMD ["bash"]
