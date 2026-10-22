FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY bin ./bin
COPY src ./src
COPY vendor ./vendor
ENV NODE_ENV=production PORT=8090
EXPOSE 8090
USER node
CMD ["node", "bin/quant-ux-mcp.js"]
