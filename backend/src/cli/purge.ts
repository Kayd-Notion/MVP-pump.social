// Run the expiry/purge job once: `docker compose exec api npm run purge`.
import { sql } from "../db.js";
import { runPurge } from "../jobs/purge.js";

const result = await runPurge();
console.log(JSON.stringify(result, null, 2));
await sql.end();
