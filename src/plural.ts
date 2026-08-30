/**
 * English plurals for counted things.
 *
 * Trivial, and worth a shared function anyway: before this the codebase had
 * three hand-written `n === 1 ? '' : 's'` ternaries and six places with none,
 * which is exactly how `--list` came to report "1 turns". Once one call site
 * has to think about it, they all do.
 *
 * Irregular plurals are passed explicitly — there is no attempt to guess.
 */

/** The right form of a word for `count` of them. */
export function plural(
  count: number,
  singular: string,
  many = `${singular}s`,
): string {
  return count === 1 ? singular : many;
}

/** The count and its word together: `counted(2, 'turn')` → `"2 turns"`. */
export function counted(
  count: number,
  singular: string,
  many?: string,
): string {
  return `${count} ${plural(count, singular, many)}`;
}
