FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=80

COPY package*.json ./
COPY src ./src
COPY public ./public
COPY data ./data

EXPOSE 80
CMD ["node", "src/server.js"]
