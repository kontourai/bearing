import { readFile } from "node:fs/promises";

import {
  parseApprovedSourceManifest,
  type ApprovedSourceManifest,
} from "../trusted-sources/manifest.js";

const packagedManifestUrl = new URL("../../../sources/approved-sources.v1.json", import.meta.url);

export const readApprovedSourceManifest = async (file: string | URL): Promise<ApprovedSourceManifest> =>
  parseApprovedSourceManifest(await readFile(file));

export const loadPackagedApprovedSourceManifest = async (): Promise<ApprovedSourceManifest> =>
  readApprovedSourceManifest(packagedManifestUrl);
