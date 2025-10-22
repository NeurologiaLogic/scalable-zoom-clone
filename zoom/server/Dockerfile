# =======================
# Stage 1: Build
# =======================
FROM node:22-bullseye AS builder

WORKDIR /usr/src/app

# Install build tools required by mediasoup
RUN apt-get update && \
    apt-get install -y python3 python3-pip make g++ && \
    ln -sf /usr/bin/python3 /usr/bin/python && \
    rm -rf /var/lib/apt/lists/*

COPY wait-for-it.sh ./wait-for-it.sh
RUN chmod +x ./wait-for-it.sh

# Copy package files and install ALL dependencies (including dev)
COPY package*.json ./
RUN npm install

# Copy the rest of the source files
COPY . .

# Run Vite build
RUN npx vite build


# =======================
# Stage 2: Production
# =======================
FROM node:22-bullseye AS production

WORKDIR /usr/src/app

# Install Python and build tools required by mediasoup
RUN apt-get update && \
    apt-get install -y python3 python3-pip make g++ && \
    ln -sf /usr/bin/python3 /usr/bin/python && \
    rm -rf /var/lib/apt/lists/*

# Install only production dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy runtime files
COPY --from=builder /usr/src/app/wait-for-it.sh ./wait-for-it.sh
RUN chmod +x ./wait-for-it.sh

# Copy built assets from builder
COPY --from=builder /usr/src/app/dist ./dist
COPY --from=builder /usr/src/app/index.js ./index.js
# (add other runtime files if needed)

EXPOSE 3000
CMD ["node", "index.js"]
