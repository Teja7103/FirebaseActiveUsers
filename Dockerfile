FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

# Install Chromium + required system dependencies via Playwright
RUN npx playwright install --with-deps chromium

COPY . .

EXPOSE 3000

CMD ["node", "src/server.js"]
