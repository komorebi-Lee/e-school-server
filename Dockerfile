FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=80

COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public

EXPOSE 80
CMD ["node", "src/server.js"]
