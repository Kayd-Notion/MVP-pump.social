// Apply pending migrations and exit: `npm run migrate` (also done at API boot).
import { sql } from "../db.js";
import { migrate } from "../migrate.js";

const applied = await migrate(sql);
console.log(applied.length ? `applied ${applied.length} migration(s)` : "database is up to date");
await sql.end();
