import { expect, it } from 'vitest'
import { databaseTypeToken } from '../scripts/lib/database-structure-comparison.mjs'

it('ignores integer display width but preserves signedness and timestamp precision', () => {
  expect(databaseTypeToken('INT(11) UNSIGNED NOT NULL')).toBe('int unsigned')
  expect(databaseTypeToken('INT NOT NULL')).not.toBe(databaseTypeToken('INT UNSIGNED NOT NULL'))
  expect(databaseTypeToken('DATETIME')).not.toBe(databaseTypeToken('DATETIME(3) NULL'))
})
it('ignores ENUM separator whitespace without erasing meaningful value case or spaces', () => {
  expect(databaseTypeToken("ENUM('auth', 'www-web') NOT NULL")).toBe(databaseTypeToken("enum('auth','www-web')"))
  expect(databaseTypeToken("ENUM('ACTIVE')")).not.toBe(databaseTypeToken("enum('active')"))
  expect(databaseTypeToken("ENUM('two words')")).not.toBe(databaseTypeToken("enum('twowords')"))
})
