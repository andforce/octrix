FROM node:22.12.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY site/package.json site/package-lock.json ./site/
RUN npm ci --prefix site
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY site ./site
RUN npm run build

FROM node:22.12.0-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/site/dist ./site/dist
RUN mkdir -p /data && chown node:node /data
EXPOSE 8790
USER node
CMD ["node", "dist/index.js"]
