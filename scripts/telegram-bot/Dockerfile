FROM node:20-alpine

RUN apk add --no-cache tini git \
    && addgroup -S ruflo \
    && adduser -S -G ruflo ruflo

WORKDIR /app

COPY --chown=ruflo:ruflo package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=ruflo:ruflo bot.js ./
COPY --chown=ruflo:ruflo tests ./tests

RUN mkdir -p /app/data /app/data/backups /app/data/signal_archive \
    && chown -R ruflo:ruflo /app/data

USER ruflo

ENV NODE_ENV=production \
    LOG_LEVEL=info \
    STRIPE_WEBHOOK_PORT=3456

EXPOSE 3456

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3456/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "bot.js"]
