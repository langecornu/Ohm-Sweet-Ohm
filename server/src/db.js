import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const DB_FILE = path.join(DATA_DIR, "sem-meter.db");

fs.mkdirSync(DATA_DIR, { recursive: true });

/** Shared SQLite connection — store.js and auth.js both persist into this one file. */
export const db = new DatabaseSync(DB_FILE);
// WAL still allows only one writer at a time. Without a busy timeout a second
// process writing (a maintenance script running next to the live server) gets
// an instant "database is locked" instead of briefly waiting its turn — and
// so could the server's own once-a-second insert.
db.exec("PRAGMA busy_timeout = 15000");
db.exec("PRAGMA journal_mode = WAL");

// The readings table grows forever by design (nothing is ever downsampled
// or expired — see the README) and is already well past what SQLite's own
// 2MB default page cache can hold. Profiled directly against production at
// ~210k rows / ~95MB on disk: a plain indexed range scan for one day
// (~43k rows) took 324ms just in SQLite itself, before any JS-side
// JSON.parse or computation — consistent with cache misses forcing real
// disk reads on every query instead of hitting memory. 32MB of dedicated
// page cache is a deliberately modest bump (this process runs on a small,
// memory-capped VM — see deploy/sem-meter.service) that should keep the
// last several days' worth of pages — the range basically every page in
// this app actually queries — resident without meaningfully risking the
// container's memory ceiling.
db.exec("PRAGMA cache_size = -32000"); // negative = KB, so 32,000KB ~= 32MB
