// src/version.ts
import pkg from "../package.json";

/** Recorded on every run (RFC-0002). The Docker image runs from source, so
 * package.json is always present; the release workflow stamps the tag's
 * version into it (ADR-0047). From a plain checkout it is the last hand-set
 * value. */
export const MOMUS_VERSION: string = pkg.version;
