# WaveForce Railway Dockerfile
FROM node:18-slim

# Set noninteractive mode for apt-get
ENV DEBIAN_FRONTEND=noninteractive

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    ffmpeg \
    libavcodec-extra \
    libavformat-dev \
    curl \
    wget \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp and ensure it's in PATH
RUN pip3 install --break-system-packages yt-dlp && \
    ln -s /usr/local/bin/yt-dlp /usr/bin/yt-dlp

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
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:8080/health || exit 1

# Start the application
CMD ["npm", "start"]
