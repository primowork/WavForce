# WaveForce Railway Dockerfile - משופר
FROM node:18-slim

# Set noninteractive mode for apt-get
ENV DEBIAN_FRONTEND=noninteractive

# Install system dependencies including Python3 (נדרש לyt-dlp)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    curl \
    wget \
    ffmpeg \
    libavcodec-extra \
    libavformat-dev \
    ca-certificates \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp via pip (יותר יציב מ-download ישיר)
RUN pip3 install --break-system-packages yt-dlp && \
    ln -s /usr/local/bin/yt-dlp /usr/bin/yt-dlp

# Verify installations (חשוב לוודא שהכלים עובדים)
RUN yt-dlp --version && echo "✅ yt-dlp installed successfully"
RUN ffmpeg -version | head -1 && echo "✅ ffmpeg installed successfully"

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

# Use fixed port instead of $PORT for EXPOSE (Railway handles port mapping)
EXPOSE 8080

# Fixed healthcheck with proper port
HEALTHCHECK --interval=30s --timeout=15s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:8080/health || exit 1

# Start the application
CMD ["npm", "start"]
