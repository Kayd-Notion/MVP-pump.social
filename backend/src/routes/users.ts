import type { FastifyInstance } from "fastify";
import { sql } from "../db.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { findUser, requireUser, requireWallet, type UserRow } from "../lib/guards.js";
import { postJson, userJson, type PostRow } from "../lib/serialize.js";
import { postSelect } from "./posts.js";

const PSEUDO_RE = /^[A-Za-z0-9_]{3,20}$/;

function checkPseudo(pseudo: unknown): string {
  const p = typeof pseudo === "string" ? pseudo.trim() : "";
  if (!PSEUDO_RE.test(p)) {
    throw badRequest("invalid_pseudo", "Pseudo invalide : 3 à 20 caractères, lettres, chiffres ou _.");
  }
  return p;
}

function isUniqueViolation(e: unknown, constraint: string): boolean {
  const err = e as { code?: string; constraint_name?: string };
  return err.code === "23505" && err.constraint_name === constraint;
}

const pseudoBody = {
  body: {
    type: "object",
    required: ["pseudo"],
    properties: { pseudo: { type: "string", maxLength: 40 } },
    additionalProperties: false,
  },
};

export async function userRoutes(app: FastifyInstance) {
  /** Create the pseudo for the authenticated wallet (first sign-in). */
  app.post<{ Body: { pseudo: string } }>("/users", { schema: pseudoBody }, async (req, reply) => {
    const wallet = await requireWallet(req);
    const pseudo = checkPseudo(req.body.pseudo);
    if (await findUser(wallet)) throw conflict("already_registered", "Ce wallet a déjà un pseudo.");
    try {
      const [user] = await sql<UserRow[]>`
        insert into users (wallet_address, pseudo) values (${wallet}, ${pseudo}) returning *`;
      return reply.status(201).send({ user: userJson(user) });
    } catch (e) {
      if (isUniqueViolation(e, "users_pseudo_lower_key")) throw conflict("pseudo_taken", "Ce pseudo est déjà pris.");
      if (isUniqueViolation(e, "users_pkey")) throw conflict("already_registered", "Ce wallet a déjà un pseudo.");
      throw e;
    }
  });

  /** Change pseudo. */
  app.patch<{ Body: { pseudo: string } }>("/users/me", { schema: pseudoBody }, async (req) => {
    const me = await requireUser(req);
    const pseudo = checkPseudo(req.body.pseudo);
    try {
      const [user] = await sql<UserRow[]>`
        update users set pseudo = ${pseudo} where wallet_address = ${me.wallet_address} returning *`;
      return { user: userJson(user) };
    } catch (e) {
      if (isUniqueViolation(e, "users_pseudo_lower_key")) throw conflict("pseudo_taken", "Ce pseudo est déjà pris.");
      throw e;
    }
  });

  /** Public profile: user, active posts, and how many of their posts expired. */
  app.get<{ Params: { pseudo: string } }>("/users/:pseudo", async (req) => {
    const [user] = await sql<UserRow[]>`select * from users where lower(pseudo) = lower(${req.params.pseudo})`;
    if (!user) throw notFound("user_not_found", "Profil introuvable.");
    const active = await sql<PostRow[]>`
      ${postSelect()}
      where p.author_wallet = ${user.wallet_address}
        and p.deleted_at is null and p.duration_expires_at > now()
      order by p.created_at desc, p.id desc
      limit 50`;
    const [counts] = await sql<{ total: number; expired: number }[]>`
      select count(*)::int as total,
             count(*) filter (where deleted_at is not null or duration_expires_at <= now())::int as expired
      from posts where author_wallet = ${user.wallet_address}`;
    return {
      user: userJson(user),
      posts_count: counts.total,
      expired_count: counts.expired,
      active: active.map(postJson),
    };
  });
}
