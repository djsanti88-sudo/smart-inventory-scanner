import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const dbPath = resolve(process.cwd(), "data", "kkm-catalog", "kkm.sqlite");
if (!existsSync(dbPath)) throw new Error("KKM database was not created");
const db = new Database(dbPath, { readonly: true });
const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(({ name }) => name);
for (const expected of ["runs", "shards", "products", "product_snapshots", "datasheet_attempts", "specs", "collection_events"]) {
  if (!names.includes(expected)) throw new Error(`Missing table: ${expected}`);
}
const product = db.prepare("PRAGMA table_info(products)").all();
if (!product.some((column) => column.name === "part_number_normalized" && column.pk === 1)) throw new Error("Product key is not normalized part number");
db.close();
console.log("KKM database schema: OK");
