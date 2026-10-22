// The tests apply the migrations with node:sqlite, which prints one experimental-feature notice per worker.
// Alternatives rejected: better-sqlite3 needs native install scripts, sql.js adds a dependency and is slower.
// Only that notice is dropped; every other warning still prints.
const emit = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const message = typeof warning === "string" ? warning : warning.message;
  if (message.startsWith("SQLite is an experimental feature")) return;
  return (emit as (...a: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;
