// Shared runtime env resolver. The Cloudflare Workers runtime, the local Node
// dev runtime, and the wrangler/cloudflare:workers binding all expose secrets
// in different places. This helper normalizes them into a single object so any
// server function can look up keys consistently — and tolerates trailing
// whitespace / surrounding quotes that sometimes leak in from .dev.vars.

export async function getRuntimeEnv(): Promise<Record<string, string | undefined>> {
  const runtimeEnv = ((globalThis as Record<string, unknown>).__runtimeEnv ?? {}) as Record<
    string,
    string | undefined
  >;
  const cfEnv = await getCloudflareEnv();
  const fileEnv = await getDevFileEnv();
  return normalizeEnvKeys({ ...fileEnv, ...process.env, ...runtimeEnv, ...cfEnv });
}

async function getDevFileEnv(): Promise<Record<string, string | undefined>> {
  try {
    const [{ readFile }, { join }] = await Promise.all([
      import("node:fs/promises"),
      import("node:path"),
    ]);
    const cwd = process.cwd?.() ?? ".";
    for (const file of [join(cwd, ".dev.vars"), join(cwd, "dist/server/.dev.vars")]) {
      try {
        return parseEnvFile(await readFile(file, "utf8"));
      } catch {
        // try the next dev-only location
      }
    }
  } catch {
    // non-Node runtimes
  }
  return {};
}

function parseEnvFile(contents: string): Record<string, string | undefined> {
  const parsed: Record<string, string | undefined> = {};
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed
      .slice(separator + 1)
      .trim()
      .replace(/^['"]|['"]$/g, "");
    if (key && value) parsed[key] = value;
  }
  return parsed;
}

function normalizeEnvKeys(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const normalized: Record<string, string | undefined> = {};
  for (const [rawKey, rawValue] of Object.entries(env)) {
    const key = rawKey.trim();
    const value = typeof rawValue === "string" ? rawValue.trim() : rawValue;
    if (key && value) normalized[key] = value;
  }
  return normalized;
}

async function getCloudflareEnv(): Promise<Record<string, string | undefined>> {
  try {
    // Keep the Worker-only module completely hidden from Vite's dependency
    // scanner. A normal dynamic import string is still detected during dev.
    const specifier = "cloudflare" + ":workers";
    const importRuntimeModule = new Function("specifier", "return import(specifier)") as (
      specifier: string,
    ) => Promise<{
      env?: Record<string, string | undefined>;
    }>;
    const mod = await importRuntimeModule(specifier);
    return mod.env ?? {};
  } catch {
    return {};
  }
}
