# The build123d service as a Cloudflare Container (see web/wrangler.jsonc).
FROM python:3.12-slim
# OpenCASCADE's Python wheels link against a few X/GL libraries even headless; ffmpeg reads videos.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 libxrender1 libxext6 libsm6 libxkbcommon0 ffmpeg \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt geometry/requirements.txt
RUN pip install --no-cache-dir -r geometry/requirements.txt
COPY *.py geometry/
EXPOSE 8790
CMD ["python", "-m", "geometry.server", "--host", "0.0.0.0", "--port", "8790"]
