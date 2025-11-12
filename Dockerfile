# WaveForce Railway Dockerfile - עם תיקון SSL
FROM node:18-slim

# Set noninteractive mode
ENV DEBIAN_FRONTEND=noninteractive

# Install system dependencies INCLUDING ca-certificates
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    curl \
    ca-certificates \
    ffmpeg \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Update CA certificates
RUN update-ca-certificates

# Create app directory
WORKDIR /app

# Copy requirements.txt and install Python dependencies (yt-dlp)
COPY requirements.txt ./
RUN pip3 install --break-system-packages -r requirements.txt

# Create symlink if needed
RUN ln -sf /usr/local/bin/yt-dlp /usr/bin/yt-dlp || true

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy app source
COPY . .

# Create temp directory
RUN mkdir -p /tmp && chmod 755 /tmp

# Expose port
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:8080/health || exit 1

# Start the application
CMD ["npm", "start"]
