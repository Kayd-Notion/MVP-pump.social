import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { sql } from "../db.js";
import { badRequest } from "../lib/errors.js";
import { requireUser } from "../lib/guards.js";
import { MEDIA_PREFIX, presignUpload, publicUrlFor } from "../lib/storage.js";
import { ALLOWED_MEDIA_TYPES } from "./meta.js";

export async function mediaRoutes(app: FastifyInstance) {
  /**
   * Step 1 of a media post: get a presigned POST form, then the browser uploads
   * the file directly to object storage (the API never proxies media bytes).
   * Step 2 is POST /posts with the returned media_key.
   */
  app.post<{ Body: { content_type: string; size: number } }>(
    "/media/presign",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        body: {
          type: "object",
          required: ["content_type", "size"],
          properties: { content_type: { type: "string" }, size: { type: "integer", minimum: 1 } },
          additionalProperties: false,
        },
      },
    },
    async (req) => {
      const me = await requireUser(req);
      const { content_type: contentType, size } = req.body;
      const type = ALLOWED_MEDIA_TYPES[contentType];
      if (!type) {
        throw badRequest("unsupported_media_type", `Type non supporté. Acceptés : ${Object.keys(ALLOWED_MEDIA_TYPES).join(", ")}.`);
      }
      if (size > config.storage.maxBytes) {
        throw badRequest("media_too_large", `Fichier trop lourd (max ${Math.floor(config.storage.maxBytes / 1024 / 1024)} Mo).`);
      }

      const key = `${MEDIA_PREFIX}${me.wallet_address}/${randomUUID()}.${type.ext}`;
      // The declared size becomes the hard upper bound enforced by storage.
      const { url, fields } = await presignUpload(key, contentType, size);
      await sql`
        insert into media_uploads (object_key, wallet_address, content_type, max_bytes)
        values (${key}, ${me.wallet_address}, ${contentType}, ${size})`;
      return {
        upload: { url, fields }, // multipart/form-data POST: fields…, then "file" last
        media_key: key,
        media_url: publicUrlFor(key),
        expires_at: new Date(Date.now() + config.storage.uploadTtlSeconds * 1000).toISOString(),
      };
    },
  );
}
