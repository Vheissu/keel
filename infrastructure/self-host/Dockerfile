FROM node:24.18.0-bookworm-slim AS build
WORKDIR /app
COPY . .
RUN npm ci && npm run build && npm prune --omit=dev

FROM node:24.18.0-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/apps/artifact-worker/dist ./apps/artifact-worker/dist
COPY --from=build /app/apps/agent-gateway/dist ./apps/agent-gateway/dist
COPY --from=build /app/apps/workflow-worker/dist ./apps/workflow-worker/dist
COPY --from=build /app/apps/operations/dist ./apps/operations/dist
COPY --from=build /app/packages/database/migrations ./packages/database/migrations
USER node
ENTRYPOINT ["node", "apps/operations/dist/main.js"]
CMD ["api"]
