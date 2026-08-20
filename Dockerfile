FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache git
COPY package*.json ./
RUN npm install --production
COPY . .
EXPOSE 3000
CMD ["node", "index.js"]
