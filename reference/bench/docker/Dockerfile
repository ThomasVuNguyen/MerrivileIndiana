FROM python:3.12-slim
RUN pip install --no-cache-dir build123d==0.13.0
COPY bench_part.py /app/bench_part.py
WORKDIR /app
CMD ["python", "bench_part.py", "/tmp"]
