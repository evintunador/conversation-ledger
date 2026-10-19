/** Stable numeric release ordering shared by discovery and pin promotion. */
export const STABLE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export function newerStableVersion(latest: string, pinned: string): boolean {
  if (latest.length > 100 || pinned.length > 100 || !STABLE.test(latest) || !STABLE.test(pinned)) return false;
  const a = latest.split(".").map(BigInt), b = pinned.split(".").map(BigInt);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return false;
}
