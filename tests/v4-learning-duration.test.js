import { expect, it } from 'vitest'
import { learningSecondsToMilliseconds as convert, convertLearningProgressValues } from '../scripts/lib/v4-learning-duration.mjs'

it('converts exact seconds without floating point, including values above JS safe integers', () => {
  expect(convert('0')).toBe('0')
  expect(convert('1.234000')).toBe('1234')
  expect(convert('9007199254740.993')).toBe('9007199254740993')
  expect(convert('9223372036854775.807')).toBe('9223372036854775807')
  expect(convert(null)).toBe(null)
})
it('rejects rounding, overflow, display durations and implicit numeric coercion', () => {
  for (const value of ['0.0001', '9223372036854775.808', '1e3', '1:30', ' 1', '-1', '', '01', 1, 'NaN']) {
    expect(() => convert(value)).toThrow()
  }
})
it('preserves over-duration progress and independent completion/quiz facts', () => {
  expect(convertLearningProgressValues({ watchedSeconds: '2049', totalDuration: '599', completed: 1, quizPassed: 0 }))
    .toEqual({ watchedMilliseconds: '2049000', reportedDurationMilliseconds: '599000', completed: 1, quizPassed: 0, watchedExceedsDuration: true })
  expect(convertLearningProgressValues({ watchedSeconds: null, totalDuration: '0', completed: null, quizPassed: 1 }))
    .toMatchObject({ watchedMilliseconds: null, reportedDurationMilliseconds: '0', completed: null, quizPassed: 1, watchedExceedsDuration: null })
})
it('does not reinterpret unexpected boolean states', () => {
  expect(() => convertLearningProgressValues({ watchedSeconds: '1', totalDuration: '2', completed: 2, quizPassed: 0 })).toThrow('flags')
})
