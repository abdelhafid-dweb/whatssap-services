# Use the official Node.js image as a base
FROM node:18-slim

# Install necessary system dependencies for Puppeteer (Chromium)
RUN apt-get update && apt-get install -y \
    chromium \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libgbm1 \
    libgdk-pixbuf2.0-0 \
    libgtk-3-0 \
    libxkbcommon-x11-0 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    lsb-release \
    xdg-utils \
    libasound2 \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Create and set the working directory
WORKDIR /app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install application dependencies
RUN npm install

# Copy the rest of the application source code
COPY . .

# Expose the port your app runs on
EXPOSE 3000

# Command to start the application
CMD ["node", "whatsapp-server.js"]
