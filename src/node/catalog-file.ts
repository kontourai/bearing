import { readFile } from "node:fs/promises";

import { parseCatalog } from "../snapshot.js";
import type { CatalogSnapshot } from "../types.js";

export const readCatalogFile = async (file: string): Promise<CatalogSnapshot> =>
  parseCatalog(await readFile(file, "utf8"));
