# Sizing probe only: what a build123d worker image would look like for Cloudflare Containers / Sandbox SDK.
FROM python:3.12-slim-trixie
RUN apt-get update && apt-get install -y --no-install-recommends libgl1 libglu1-mesa libxrender1 libxext1 libx11-6 && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir build123d
# Sandbox SDK helper would be: COPY --from=docker.io/cloudflare/sandbox:<ver> /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
CMD ["sleep", "infinity"]
