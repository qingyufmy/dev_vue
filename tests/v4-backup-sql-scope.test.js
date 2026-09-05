import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { BackupSqlScopeError, inspectBackupSql } from '../scripts/lib/v4-backup-sql-scope.mjs'

const tables = [
  { name: 'users', columns: [{ name: 'id' }, { name: 'display_name' }, { name: 'payload' }] },
  { name: 'user_notes', columns: [{ name: 'id' }, { name: 'user_id' }, { name: 'note' }] },
]

function dump({ users = [], notes = [], header = true, footer = true } = {}) {
  const statements = []
  if (header) statements.push(
    '/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;',
    '/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;',
    '/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;',
    '/*!50503 SET NAMES utf8mb4 */;',
    '/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;',
    "/*!40103 SET TIME_ZONE='+00:00' */;",
    '/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;',
    '/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;',
    "/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;",
    '/*!40111 SET @OLD_SQL_NOTES=@@SQL_NOTES, SQL_NOTES=0 */;',
    'SET autocommit=0;',
  )
  statements.push(
    'CREATE TABLE `users` (`id` bigint NOT NULL, `display_name` varchar(100), `payload` blob, PRIMARY KEY (`id`)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;',
    'CREATE TABLE `user_notes` (`id` bigint NOT NULL, `user_id` bigint, `note` text, CONSTRAINT `fk_note_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)) ENGINE=InnoDB;',
  )
  for (const [id, name, payload] of users) {
    statements.push(`INSERT INTO \`users\` (\`id\`,\`display_name\`,\`payload\`) VALUES (${id},'${name}',${payload});`)
  }
  for (const [id, userId, note] of notes) {
    statements.push(`INSERT INTO \`user_notes\` (\`id\`,\`user_id\`,\`note\`) VALUES (${id},${userId},'${note}');`)
  }
  if (footer) statements.push(
    'COMMIT;',
    '/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;',
    '/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;',
    '/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;',
    '/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;',
    '/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;',
    '/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;',
    '/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;',
    '/*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;',
  )
  return `${statements.join('\n')}\n`
}

async function *chunks(value, size = 7) {
  const source = Buffer.from(value, 'utf8')
  for (let index = 0; index < source.length; index += size) yield source.subarray(index, Math.min(index + size, source.length))
}

async function review(sql, options = {}) {
  return inspectBackupSql(chunks(sql), { tables, ...options })
}

async function expectCode(sql, code, options = {}) {
  await expect(review(sql, options)).rejects.toSatisfy(error => error instanceof BackupSqlScopeError && error.code === code)
}

describe('bounded mysqldump SQL scope review', () => {
  it('accepts a common dump header/footer and returns exact row counts and hashes', async () => {
    const sql = dump({ users: [[1, 'Alice', '0x00ff'], [2, 'Bob', '0x1234']], notes: [[1, 1, 'hello']] })
    const result = await review(sql)
    const userInsert = 'INSERT INTO `users` (`id`,`display_name`,`payload`) VALUES (1,\'Alice\',0x00ff);\n'
      + 'INSERT INTO `users` (`id`,`display_name`,`payload`) VALUES (2,\'Bob\',0x1234);\n'
    const noteInsert = 'INSERT INTO `user_notes` (`id`,`user_id`,`note`) VALUES (1,1,\'hello\');\n'
    expect(result.kind).toBe('v4_backup_sql_review')
    expect(result.tables).toEqual([
      { name: 'users', rows: '2', dataSha256: createHash('sha256').update(userInsert).digest('hex') },
      { name: 'user_notes', rows: '1', dataSha256: createHash('sha256').update(noteInsert).digest('hex') },
    ])
    expect(result.statementCount).toBe(25)
    expect(JSON.stringify(result)).not.toContain('Alice')
  })

  it('handles quotes, escaped delimiters, newlines, comments, and chunk boundaries lexically', async () => {
    const sql = [
      'CREATE TABLE `users` (`id` int, `display_name` text, `payload` blob) ENGINE=InnoDB;',
      'CREATE TABLE `user_notes` (`id` int, `user_id` int, `note` text) ENGINE=InnoDB;',
      "INSERT INTO `users` (`id`, `display_name`, `payload`) VALUES (1, 'semi; -- not SQL /* no */', _binary 'line\\nnext'); /* trailing ; DROP TABLE users */",
      "INSERT INTO `user_notes` (`id`, `user_id`, `note`) VALUES (1, 1, 'double '' quote; and \\\\'); -- comment;\n",
    ].join('\n')
    const result = await review(sql, { maxStatementBytes: 4096 })
    expect(result.tables.map(table => table.rows)).toEqual(['1', '1'])
  })

  it.each([
    ['USE `dev_vue`;', 'backup_sql_statement_forbidden'],
    ['CREATE DATABASE `evil`;', 'backup_sql_object_forbidden'],
    ['DROP TABLE `users`;', 'backup_sql_statement_forbidden'],
    ['SET GLOBAL sql_mode = \'\';', 'backup_sql_global_scope_forbidden'],
    ['GRANT ALL ON *.* TO \'x\';', 'backup_sql_statement_forbidden'],
    ['LOAD DATA INFILE \'x\' INTO TABLE `users`;', 'backup_sql_statement_forbidden'],
    ['CALL dangerous();', 'backup_sql_statement_forbidden'],
    ['DELIMITER $$;', 'backup_sql_client_command'],
    ['\\. other.sql;', 'backup_sql_client_command'],
    ['CREATE TRIGGER `t` BEFORE INSERT ON `users` FOR EACH ROW SET @x=1;', 'backup_sql_object_forbidden'],
    ['CREATE PROCEDURE `p`() SELECT 1;', 'backup_sql_object_forbidden'],
    ['CREATE EVENT `e` ON SCHEDULE EVERY 1 DAY DO SELECT 1;', 'backup_sql_object_forbidden'],
  ])('rejects forbidden statement %s', async (statement, code) => {
    const sql = `${statement}\nCREATE TABLE \`users\` (\`id\` int, \`display_name\` text, \`payload\` blob) ENGINE=InnoDB;\nCREATE TABLE \`user_notes\` (\`id\` int, \`user_id\` int, \`note\` text) ENGINE=InnoDB;`
    await expectCode(sql, code)
  })

  it('rejects hidden executable-comment injection and qualified schema names', async () => {
    await expectCode('/*!40101 SET NAMES utf8mb4; DROP TABLE `users` */;', 'backup_sql_statement_forbidden')
    await expectCode('CREATE TABLE `dev_vue`.`users` (`id` int, `display_name` text, `payload` blob) ENGINE=InnoDB;', 'backup_sql_cross_schema_identifier')
    await expectCode('CREATE TABLE `users` (`id` int, `display_name` text, `payload` blob) ENGINE=InnoDB;\nCREATE TABLE `user_notes` (`id` int, `user_id` int, `note` text) ENGINE=InnoDB;\nINSERT INTO `dev_vue`.`users` (`id`,`display_name`,`payload`) VALUES (1,\'x\',0x00);', 'backup_sql_cross_schema_identifier')
  })

  it('rejects multi-row inserts, suffix expressions, functions, and unsafe DDL', async () => {
    const prefix = 'CREATE TABLE `users` (`id` int, `display_name` text, `payload` blob) ENGINE=InnoDB;\nCREATE TABLE `user_notes` (`id` int, `user_id` int, `note` text) ENGINE=InnoDB;\n'
    await expectCode(`${prefix}INSERT INTO \`users\` (\`id\`,\`display_name\`,\`payload\`) VALUES (1,'x',0x00),(2,'y',0x01);`, 'backup_sql_multirow_insert')
    await expectCode(`${prefix}INSERT INTO \`users\` (\`id\`,\`display_name\`,\`payload\`) VALUES (1,'x',0x00) ON DUPLICATE KEY UPDATE \`id\`=2;`, 'backup_sql_insert_suffix_forbidden')
    await expectCode('CREATE TABLE `users` (`id` int DEFAULT uuid(), `display_name` text, `payload` blob) ENGINE=InnoDB;\nCREATE TABLE `user_notes` (`id` int, `user_id` int, `note` text) ENGINE=InnoDB;', 'backup_sql_function_forbidden')
    await expectCode('CREATE TABLE `users` (`id` int, `display_name` text, `payload` blob) ENGINE=MyISAM;\nCREATE TABLE `user_notes` (`id` int, `user_id` int, `note` text) ENGINE=InnoDB;', 'backup_sql_engine_forbidden')
    await expectCode('CREATE TABLE `users` (`id` int, `display_name` text, `payload` blob) DATA DIRECTORY=\'/tmp\' ENGINE=InnoDB;\nCREATE TABLE `user_notes` (`id` int, `user_id` int, `note` text) ENGINE=InnoDB;', 'backup_sql_ddl_option_forbidden')
    await expectCode(`${prefix}INSERT INTO \`users\` (\`id\`,\`display_name\`,\`payload\`) VALUES (1,'x',X'abc');`, 'backup_sql_insert_values_invalid')
    await expectCode(`${prefix}INSERT INTO \`users\` (\`id\`,\`display_name\`,\`payload\`) VALUES (1,'x',0X00);`, 'backup_sql_insert_values_invalid')
    const emptyHex = await review(`${prefix}INSERT INTO \`users\` (\`id\`,\`display_name\`,\`payload\`) VALUES (1,'x',X'');`)
    expect(emptyHex.tables[0].rows).toBe('1')
  })

  it('accepts mysqldump character-set save/restore and common DDL literal shapes', async () => {
    const sql = [
      '/*!40101 SET @saved_cs_client     = @@character_set_client */;',
      '/*!50503 SET character_set_client = utf8mb4 */;',
      'CREATE TABLE `users` (`id` bigint, `display_name` varchar(100), `payload` blob, `created_at` datetime(3), KEY `idx_name` (`display_name`(12)), CONSTRAINT `fk_self` FOREIGN KEY (`id`) REFERENCES `users` (`id`), CHECK (json_valid(`payload`))) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT=\'safe ) comment\';',
      'CREATE TABLE `user_notes` (`id` bigint, `user_id` bigint, `note` text, KEY `idx_user` (`user_id`(4))) ENGINE=InnoDB;',
      '/*!40101 SET character_set_client = @saved_cs_client */;',
    ].join('\n')
    const result = await review(sql)
    expect(result.tables.every(table => table.rows === '0')).toBe(true)
  })

  it('rejects SELECT-shaped CREATE statements and quoted identifier calls', async () => {
    const prefix = 'CREATE TABLE `user_notes` (`id` int, `user_id` int, `note` text) ENGINE=InnoDB;\n'
    await expectCode('CREATE TABLE `users` (`id` int, `display_name` text, `payload` blob) ENGINE=InnoDB SELECT 1;\n' + prefix, 'backup_sql_create_as_forbidden')
    await expectCode('CREATE TABLE `users` (`id` int DEFAULT (`evil`()), `display_name` text, `payload` blob) ENGINE=InnoDB;\n' + prefix, 'backup_sql_function_forbidden')
    await expectCode('CREATE TABLE `users` (`id` int, `display_name` text, `payload` blob, CHECK ((`id` > 0)), KEY `idx_name` ((`evil`())) ) ENGINE=InnoDB;\n' + prefix, 'backup_sql_function_forbidden')
    const nestedCheck = await review('CREATE TABLE `users` (`id` int, `display_name` text, `payload` blob, CHECK ((json_valid(`payload`)))) ENGINE=InnoDB;\n' + prefix)
    expect(nestedCheck.tables.every(table => table.rows === '0')).toBe(true)
    await expectCode('CREATE TABLE `users` (`id` int, `display_name` text, `payload` blob);\n' + prefix, 'backup_sql_engine_invalid')
  })

  it('rejects unknown, duplicate, or missing tables and incorrect complete columns', async () => {
    await expectCode('CREATE TABLE `unknown` (`id` int);', 'backup_sql_unknown_table')
    const one = 'CREATE TABLE `users` (`id` int, `display_name` text, `payload` blob) ENGINE=InnoDB;\n'
    await expectCode(`${one}${one}CREATE TABLE \`user_notes\` (\`id\` int, \`user_id\` int, \`note\` text) ENGINE=InnoDB;`, 'backup_sql_duplicate_table')
    await expectCode('CREATE TABLE `users` (`id` int, `display_name` text, `payload` blob) ENGINE=InnoDB;', 'backup_sql_missing_table')
    await expectCode('CREATE TABLE `users` (`id` int, `display_name` text, `payload` blob) ENGINE=InnoDB;\nCREATE TABLE `user_notes` (`id` int, `user_id` int, `note` text) ENGINE=InnoDB;\nINSERT INTO `users` (`display_name`,`id`,`payload`) VALUES (\'x\',1,0x00);', 'backup_sql_insert_columns_invalid')
  })

  it('does not include table-name comments in the per-table INSERT digest', async () => {
    const prefix = 'CREATE TABLE `users` (`id` int, `display_name` text, `payload` blob) ENGINE=InnoDB;\nCREATE TABLE `user_notes` (`id` int, `user_id` int, `note` text) ENGINE=InnoDB;\n'
    const insert = "INSERT INTO `users` (`id`,`display_name`,`payload`) VALUES (1,'x',0x00);"
    const first = await review(`${prefix}-- Dumping data for table \`source_name\`\n${insert}`)
    const second = await review(`${prefix}-- Dumping data for table \`restored_name\`\n${insert}`)
    expect(first.tables[0].dataSha256).toBe(second.tables[0].dataSha256)
  })

  it('enforces stream, statement, UTF-8, and termination bounds without SQL in errors', async () => {
    const valid = 'CREATE TABLE `users` (`id` int, `display_name` text, `payload` blob) ENGINE=InnoDB;\nCREATE TABLE `user_notes` (`id` int, `user_id` int, `note` text) ENGINE=InnoDB;'
    await expectCode(valid.slice(0, -1), 'backup_sql_truncated')
    await expectCode(`${valid}\nINSERT INTO \`users\` (\`id\`,\`display_name\`,\`payload\`) VALUES (1,'long value',0x00);`, 'backup_sql_too_large', { maxBytes: Buffer.byteLength(valid) })
    await expectCode(`${valid}\nINSERT INTO \`users\` (\`id\`,\`display_name\`,\`payload\`) VALUES (1,'this is too long',0x00);`, 'backup_sql_statement_too_large', { maxStatementBytes: 20 })
    await expectCode(Buffer.from([...Buffer.from(valid), 0xff]), 'backup_sql_invalid_utf8')
    const result = await inspectBackupSql(chunks(`${valid}\n`, 1), { tables, maxBytes: Buffer.byteLength(`${valid}\n`) })
    expect(result.tables.every(table => table.rows === '0')).toBe(true)
    await expectCode('DELIMITER $$\nCREATE TABLE `users` (`id` int, `display_name` text, `payload` blob) ENGINE=InnoDB$$', 'backup_sql_client_command')
  })

  it('streams a 10 MiB non-sensitive literal within the statement bound', async () => {
    const body = 'a'.repeat(10 * 1024 * 1024)
    const sql = [
      'CREATE TABLE `users` (`id` int, `display_name` longtext, `payload` blob) ENGINE=InnoDB;',
      'CREATE TABLE `user_notes` (`id` int, `user_id` int, `note` text) ENGINE=InnoDB;',
      `INSERT INTO \`users\` (\`id\`,\`display_name\`,\`payload\`) VALUES (1,'${body}',X'');`,
    ].join('\n')
    const started = Date.now()
    const result = await inspectBackupSql(chunks(sql, 64 * 1024), { tables, maxStatementBytes: 12 * 1024 * 1024 })
    expect(result.tables[0].rows).toBe('1')
    expect(result.tables[1].rows).toBe('0')
    expect(Date.now() - started).toBeLessThan(15000)
  })
})
