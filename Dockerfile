FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv \
    && rm -rf /var/lib/apt/lists/*

RUN python3 -m venv /opt/dreamy-python
ENV PATH="/opt/dreamy-python/bin:${PATH}"

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY python/requirements-web.txt ./python/requirements-web.txt
RUN pip install --no-cache-dir -r python/requirements-web.txt \
    && pip install --no-cache-dir \
       --index-url https://download.pytorch.org/whl/cpu \
       --extra-index-url https://pypi.org/simple \
       'torch>=2.0' 'torchvision>=0.15'

COPY . .

ENV HOST=0.0.0.0
ENV PORT=8080
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "web-server.js"]
