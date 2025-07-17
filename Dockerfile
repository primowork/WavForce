# WaveForce Railway Dockerfile
FROM node:18-slim

# Set noninteractive mode for apt-get
ENV DEBIAN_FRONTEND=noninteractive

# Install system dependencies including curl
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ffmpeg \
    libavcodec-extra \
    libavformat-dev \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp using the official binary
RUN curl -L https://yt-dlp.org/downloads/latest/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy app source
COPY . .

# Create temp directory for conversions
RUN mkdir -p /tmp && chmod 755 /tmp

# Expose port (use Railway's PORT)
EXPOSE $PORT

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:$PORT/health || exit 1

# Start the application
CMD ["npm", "start"]
