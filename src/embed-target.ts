/**
 * Choose the Markdown leaf that owns an automatic embed insertion.
 *
 * The requested leaf is exact. Resolution never redirects a prepared capture
 * to another Markdown tab, because that could focus or write into the wrong
 * note if the user switches tabs while a long capture is running.
 */
export function chooseEmbedInsertionTarget<T>(options: {
  liveLeaves: readonly T[];
  requestedLeaf: T | null;
  isEditable: (leaf: T) => boolean;
}): T | null {
  const live = new Set(options.liveLeaves);
  return options.requestedLeaf
    && live.has(options.requestedLeaf)
    && options.isEditable(options.requestedLeaf)
    ? options.requestedLeaf
    : null;
}
