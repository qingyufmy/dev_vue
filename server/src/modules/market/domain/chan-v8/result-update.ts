/** Preserve the window object's hidden, immutable audit properties during diagnostic updates. */
export function updateChanResultInPlace<T extends object>(result: T, updates: Partial<T> = {}): T {
  if (!result || typeof result !== 'object') return result
  Object.assign(result, updates)
  return result
}
export function updateClonedChanResult<T extends object>(result: T, updates: Partial<T> = {}): T {
  if (!result || typeof result !== 'object') return result
  const clone = Object.create(Object.getPrototypeOf(result), Object.getOwnPropertyDescriptors(result)) as T
  return updateChanResultInPlace(clone, updates)
}
