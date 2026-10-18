/**
 * The harness version carried in every result.json (`generator.version`). A constant rather than a
 * read of package.json because the runner is also bundled into a plugin, where there is no
 * package.json beside it; test/version.test.ts keeps it equal to package.json.
 */
export const VERSION = "0.1.0";
