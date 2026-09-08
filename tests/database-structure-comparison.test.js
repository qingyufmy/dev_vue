import { expect, it } from 'vitest'
import { databaseTypeToken, plannedDefault, defaultDifference } from '../scripts/lib/database-structure-comparison.mjs'

it('ignores integer display width but preserves signedness and timestamp precision', () => {
  expect(databaseTypeToken('INT(11) UNSIGNED NOT NULL')).toBe('int unsigned')
  expect(databaseTypeToken('INT NOT NULL')).not.toBe(databaseTypeToken('INT UNSIGNED NOT NULL'))
  expect(databaseTypeToken('DATETIME')).not.toBe(databaseTypeToken('DATETIME(3) NULL'))
})
it('keeps implicit null, zero and empty-string defaults distinct and flags unknown expressions', () => {
  expect(plannedDefault('INT NOT NULL')).toEqual({ kind: 'value', value: null })
  expect(defaultDifference({ column_default: '0' }, 'INT NOT NULL').status).toBe('different')
  expect(defaultDifference({ column_default: '' }, "VARCHAR(10) DEFAULT ''").status).toBe('matches')
  expect(plannedDefault("VARCHAR(10) DEFAULT 'it''s'").value).toBe("it's")
  expect(defaultDifference({ column_default: 'now(3)' }, 'DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)').status).toBe('matches')
  expect(defaultDifference({ column_default: 'now()' }, 'DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)').status).toBe('different')
  expect(plannedDefault('JSON DEFAULT (JSON_OBJECT())').kind).toBe('unreviewed_expression')
})
it('ignores ENUM separator whitespace without erasing meaningful value case or spaces', () => {
  expect(databaseTypeToken("ENUM('auth', 'www-web') NOT NULL")).toBe(databaseTypeToken("enum('auth','www-web')"))
  expect(databaseTypeToken("ENUM('ACTIVE')")).not.toBe(databaseTypeToken("enum('active')"))
  expect(databaseTypeToken("ENUM('two words')")).not.toBe(databaseTypeToken("enum('twowords')"))
})
