/** Log estruturado em linha unica, sem dependencia externa. */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type Level = keyof typeof LEVELS;

let threshold: number = LEVELS.info;

export function setLevel(level: string): void {
  if (level in LEVELS) threshold = LEVELS[level as Level];
}

function emit(level: Level, component: string, msg: string, extra?: Record<string, unknown>): void {
  if (LEVELS[level] < threshold) return;
  const parts = [
    new Date().toISOString(),
    level.toUpperCase().padEnd(5),
    component.padEnd(8),
    msg,
  ];
  if (extra && Object.keys(extra).length > 0) {
    parts.push(
      Object.entries(extra)
        .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
        .join(" "),
    );
  }
  const line = parts.join(" | ");
  if (level === "error") console.error(line);
  else console.log(line);
}

export function logger(component: string) {
  return {
    debug: (m: string, e?: Record<string, unknown>) => emit("debug", component, m, e),
    info: (m: string, e?: Record<string, unknown>) => emit("info", component, m, e),
    warn: (m: string, e?: Record<string, unknown>) => emit("warn", component, m, e),
    error: (m: string, e?: Record<string, unknown>) => emit("error", component, m, e),
  };
}
