FROM docker.io/cloudflare/sandbox:0.10.2

RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl ca-certificates build-essential jq sudo ripgrep \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) \
        signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] \
        https://cli.github.com/packages stable main" \
    | tee /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://opencode.ai/install.sh | sh

RUN curl -fsSL https://mise.run | sh \
    && mv ~/.local/bin/mise /usr/local/bin/mise

RUN mise use -g npm:@schpet/linear-cli

ENV MISE_DATA_DIR=/workspace/.mise
