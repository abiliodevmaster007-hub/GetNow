# Use an official lightweight Node.js base image
FROM node:20-bullseye-slim

# Install core system dependencies:
# - python3: Required by yt-dlp to run extractor scripts
# - ffmpeg: Required by yt-dlp to merge video + audio and convert to MP3
# - curl: Utility for fetching assets and binary packages
RUN apt-get update && apt-get install -y \
    python3 \
    ffmpeg \
    curl \
    && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp \
    && rm -rf /var/lib/apt/lists/*

# Set the working directory inside the container
WORKDIR /app

# Install package dependencies first (exploiting Docker build cache layer)
COPY package*.json ./
RUN npm install

# Copy the rest of the application codebase
COPY . .

# Build Vite static assets and bundle Express backend to CJS Coded server
RUN npm run build

# Render defaults to setting PORT inside environment variable
ENV NODE_ENV=production
ENV PORT=3000

# Expose port 3000
EXPOSE 3000

# Execute server boot sequence
CMD ["npm", "start"]
