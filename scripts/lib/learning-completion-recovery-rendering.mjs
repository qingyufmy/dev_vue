import { tableDefinitionHash } from './inplace-foundation-upgrade.mjs'

// Narrowly reviewed recovery rendering: MySQL changes this ASCII-only regex
// literal introducer when restoring/rebuilding the four imported learning tables.
// The production database and all other definitions retain exact fingerprints.
const known = {
  learning_courses: ['e8def6bdb12c0e7563099f86acf3b7dd9388427c598e2368786baa123d87c79d','1704d07700664b378990229b044bf187ad4609538b02cde9292ebd9cc1e16029'],
  learning_lessons: ['f2b9a3fef2dca3ea018b627df980e6ae0a2d5a2096d56f326e28d92688c2ae66','4ea1993c948440fd6213ba08c8b32b83731ff6d3b6226d32644211260302af08'],
  learning_media_references: ['af70717d93e1bc9303fbe2b59faa92175482102f84595570b1d9acb701385e4b','c5d2e88202fe4b4b144573f1c03879ad506465f660af2f257972258098feb1cb'],
  learning_progress: ['d11c9178477907d8d312e2a78c562cdd4887460f50491370d610aba3cdbc2813','55086c9277398c240acb90c19ae8d6c84d5b653d238679204076dcc397f7d50b'],
}
export function recoveryLearningDefinitionHash(database, table, ddl) {
  const hash = tableDefinitionHash(ddl), pair = known[table]
  if (database !== 'dev_vue_m1_source_20260907_02' || !pair || hash !== pair[0]) return hash
  const normalized = ddl.replace("regexp_like(`source_sha256`,_ascii'[^0-9a-f]',_utf8mb4'c')", "regexp_like(`source_sha256`,_utf8mb4'[^0-9a-f]',_utf8mb4'c')")
  if (tableDefinitionHash(normalized) !== pair[1]) throw Error('learning_completion_recovery_rendering_conflict')
  return pair[1]
}
