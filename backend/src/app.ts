import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { config } from "./config.js";
import { HttpError } from "./lib/errors.js";
import { metaRoutes } from "./routes/meta.js";
import { authRoutes } from "./routes/auth.js";
import { userRoutes } from "./routes/users.js";
import { mediaRoutes } from "./routes/media.js";
import { postRoutes } from "./routes/posts.js";
import { pumpRoutes } from "./routes/pumps.js";
import { leaderboardRoutes } from "./routes/leaderboard.js";

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.env === "production" ? "info" : "debug",
      // Never log bearer tokens.
      redact: ["req.headers.authorization"],
    },
    trustProxy: config.trustProxy,
    bodyLimit: 64 * 1024, // JSON only; media goes straight to object storage
  });

  await app.register(cors, {
    origin: config.corsOrigins,
    methods: ["GET", "POST", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    maxAge: 600,
  });

  await app.register(rateLimit, { global: true, max: 300, timeWindow: "1 minute" });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.statusCode).send({ error: err.code, message: err.message });
    }
    const e = err as { validation?: unknown; statusCode?: number; message: string };
    if (e.validation) {
      return reply.status(400).send({ error: "invalid_request", message: e.message });
    }
    if (e.statusCode === 429) {
      return reply.status(429).send({ error: "rate_limited", message: "Trop de requêtes, réessaie dans un instant." });
    }
    req.log.error(err);
    return reply.status(500).send({ error: "internal_error", message: "Erreur interne." });
  });

  app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: "not_found", message: "Route inconnue." }));

  await app.register(metaRoutes);
  await app.register(authRoutes);
  await app.register(userRoutes);
  await app.register(mediaRoutes);
  await app.register(postRoutes);
  await app.register(pumpRoutes);
  await app.register(leaderboardRoutes);

  return app;
}
