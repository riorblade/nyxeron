/** What the api answers for a verified swap (services/api/restock.go → Restocked). */
export type Restocked = {
  units?: number;
  short?: number;
  others?: Record<string, number>;
};

/**
 * The back office's line after a reported swap. Every verified swap is booked (#55), so "0 added" is a real outcome:
 * a buy under one unit (the fraction stays in the wallet), or units that only covered a shortfall on chain.
 */
export function restockMessage(
  got: Restocked,
  token: string,
  ticker: (t: string) => string,
  fmt: (n: number) => string,
): string {
  const units = got.units ?? 0;
  const short = got.short ?? 0;
  const parts = [
    units > 0
      ? `✓ Added ${fmt(units)} ${ticker(token)} from the swap`
      : short > 0
        ? `✓ Swap booked: no ${ticker(token)} added`
        : `✓ Swap booked: under one unit of ${ticker(token)}, the fraction stays in the wallet`,
  ];
  if (short > 0)
    parts.push(
      `${fmt(short)} more covered units the wallet was short on chain`,
    );
  for (const [t, n] of Object.entries(got.others ?? {}))
    parts.push(`plus ${fmt(n)} ${ticker(t)}`);
  return parts.join("; ");
}
