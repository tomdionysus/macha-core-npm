/**
 * "Firefly · Season 1 Episode 4", or the ancestor alone when the item has
 * nothing to add. Internal, and not exported from the package: the one place
 * the separator is spelled, for `episodeSubtitle` and the search hits.
 */
export function joinSubtitle(ancestor: string, own: string | undefined): string {
  return own ? `${ancestor} · ${own}` : ancestor;
}
