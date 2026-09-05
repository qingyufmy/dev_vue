import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const files = [
  '20260905_015_macro_sources_and_observations.sql',
  '20260905_016_macro_snapshot_research.sql',
  '20260905_017_economic_calendar.sql',
]

describe('M1 macro migration contract', () => {
  it('keeps every macro migration append-only and scoped to the V4 side-by-side target', async () => {
    for (const file of files) {
      const sql = await migration(file)
      expect(sql).toContain('V4 side-by-side database')
      expect(sql).toContain('Never run against the legacy source database')
      expect(sql).not.toMatch(/\b(?:DROP|TRUNCATE|RENAME)\b/i)
      expect(sql).not.toMatch(/\b(?:COMMIT|START TRANSACTION)\b/i)
    }
  })

  it('stores point-in-time observations with immutable identity and no secret material', async () => {
    const sql = await migration(files[0]!)
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS macro_data_sources')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS macro_observations')
    expect(sql).toContain('observation_at_utc DATETIME(3) NOT NULL')
    expect(sql).toContain('available_at_utc DATETIME(3) NOT NULL')
    expect(sql).toContain('ingested_at_utc DATETIME(3) NOT NULL')
    expect(sql).toContain('uk_macro_observation_version')
    expect(sql).toContain('credential_ref')
    expect(sql).not.toMatch(/api_key|access_token|secret_value/i)
  })

  it('extends one platform snapshot authority and preserves observation lineage', async () => {
    const sql = await migration(files[1]!)
    expect(sql).toContain('ALTER TABLE macro_research_snapshots')
    expect(sql).toContain('chk_macro_snapshot_platform_v1')
    expect(sql).toContain("schema_version=0 OR (owner_scope='platform' AND owner_user_id IS NULL)")
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS macro_snapshot_observations')
    expect(sql).toContain('uk_macro_snapshot_active_publication')
  })

  it('uses provider event identity and append-only revisions for the calendar', async () => {
    const sql = await migration(files[2]!)
    expect(sql).toContain('uk_economic_calendar_provider_event')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS economic_calendar_event_revisions')
    expect(sql).toContain('provider_revision_key')
    expect(sql).toContain('provider_event_id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL')
    expect(sql).toContain('provider_revision_key VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NULL')
    expect(sql).toContain('uk_economic_calendar_revision_content')
    expect(sql).not.toMatch(/CONCAT\([^\n]*title/i)
    expect(sql).toContain('available_at_utc DATETIME(3) NOT NULL')
  })
})

function migration(file: string) {
  return readFile(new URL(`../db/migrations/${file}`, import.meta.url), 'utf8')
}
