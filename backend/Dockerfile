
FROM node:22-bookworm

ENV NODE_ENV=production
ENV CHROME_EXECUTABLE_PATH=/usr/bin/google-chrome-stable
ENV IRCTC_LAUNCH_HEADLESS=false

WORKDIR /app

# Install Chrome dependencies and virtual display
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    gnupg \
    fonts-liberation \
    fonts-noto-color-emoji \
    xvfb \
    xauth \
    x11-utils \
    && mkdir -p /usr/share/keyrings \
    && curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
       | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" \
       > /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends google-chrome-stable \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js dependencies
COPY package*.json ./
RUN npm ci

# Copy backend source code
COPY . .

EXPOSE 3000

# Run the backend with a virtual X display
CMD ["sh", "-c", "Xvfb :99 -screen 0 1280x1024x24 -ac -nolisten tcp & export DISPLAY=:99; sleep 1; exec npm start"]
