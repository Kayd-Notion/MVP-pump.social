// Recompute every derived counter from the append-only `pumps` table:
// `docker compose exec api npm run rebuild-aggregates`.
import { sql } from "../db.js";
import { rebuildAggregates } from "../lib/aggregates.js";

const result = await rebuildAggregates(sql);
console.log(JSON.stringify(result, null, 2));
await sql.end();
