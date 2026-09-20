/** Only display values may change while the user confirms a resource command. */
export function sameCommandTarget(before: Record<string, unknown>, after: Record<string, unknown>) {
  const project = (item: Record<string, unknown>) => Object.keys(item).sort()
    .filter(key => !['currentPrice', 'floatingProfit', 'revision'].includes(key))
    .map(key => [key, item[key]])
  return JSON.stringify(project(before)) === JSON.stringify(project(after))
}
