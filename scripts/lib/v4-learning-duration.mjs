import { exactKeys, requireBackfill as check } from './v4-backfill-contract.mjs'

const maximum = 9223372036854775807n
// Receives the frozen SQL decimal text, not a JavaScript floating-point number.
// Never rounds sub-millisecond values or interprets a display string as seconds.
export function learningSecondsToMilliseconds(value) {
  if (value === null) return null
  check(typeof value === 'string' && value.length <= 100, 'learning_duration_representation')
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/.exec(value)
  check(match, 'learning_duration_format')
  const fraction = match[2] || ''
  check(!/[1-9]/.test(fraction.slice(3)), 'learning_duration_precision')
  const result = BigInt(match[1]) * 1000n + BigInt(fraction.slice(0, 3).padEnd(3, '0'))
  check(result <= maximum, 'learning_duration_range')
  return result.toString()
}

export function convertLearningProgressValues(source) {
  exactKeys(source, ['watchedSeconds', 'totalDuration', 'completed', 'quizPassed'])
  check([null, 0, 1].includes(source.completed) && [null, 0, 1].includes(source.quizPassed), 'learning_progress_flags')
  const watchedMilliseconds = learningSecondsToMilliseconds(source.watchedSeconds)
  const reportedDurationMilliseconds = learningSecondsToMilliseconds(source.totalDuration)
  return { watchedMilliseconds, reportedDurationMilliseconds, completed: source.completed, quizPassed: source.quizPassed,
    watchedExceedsDuration: watchedMilliseconds === null || reportedDurationMilliseconds === null ? null
      : BigInt(watchedMilliseconds) > BigInt(reportedDurationMilliseconds) }
}
