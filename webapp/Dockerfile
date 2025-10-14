FROM node:22-alpine AS base

# Install dependencies only when needed
FROM base AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

# Rebuild the source code only when needed
FROM base AS builder
WORKDIR /app

# Accept build arguments for DVM configuration
ARG NEXT_PUBLIC_DVM_NPUB
ARG NEXT_PUBLIC_DVM_PUBKEY_HEX
ARG NEXT_PUBLIC_RELAY_URL

# Set them as environment variables for the build
ENV NEXT_PUBLIC_DVM_NPUB=$NEXT_PUBLIC_DVM_NPUB
ENV NEXT_PUBLIC_DVM_PUBKEY_HEX=$NEXT_PUBLIC_DVM_PUBKEY_HEX
ENV NEXT_PUBLIC_RELAY_URL=$NEXT_PUBLIC_RELAY_URL

COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN npm run build

# Production image, copy all the files and run next
FROM base AS runner
WORKDIR /app

ENV NODE_ENV production

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public

# Set the correct permission for prerender cache
RUN mkdir .next
RUN chown nextjs:nodejs .next

# Automatically leverage output traces to reduce image size
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs

EXPOSE 3000

ENV PORT 3000
ENV HOSTNAME "0.0.0.0"

CMD ["node", "server.js"]
