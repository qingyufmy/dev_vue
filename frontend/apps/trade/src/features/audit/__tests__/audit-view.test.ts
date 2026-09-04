import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { router } from '../../../router'

const feature = (path: string) => readFileSync(resolve(process.cwd(), 'src/features/audit', path), 'utf8')

describe('audit workspace', () => {
  it('exposes a lazy audit route instead of the module placeholder', () => {
    const route = router.getRoutes().find((item) => item.path === '/audit')
    expect(route?.name).toBe('audit')
    expect(String(route?.components?.default)).toContain('features/audit')
    expect(String(route?.components?.default)).not.toContain('ModulePlaceholderView')
  })

  it('uses shadcn-vue primitives for filters, summaries, table and detail disclosure', () => {
    const view = feature('views/AuditView.vue')
    const filters = feature('components/AuditFilterBar.vue')
    const summary = feature('components/AuditSummaryCards.vue')
    const table = feature('components/AuditEventTable.vue')
    const detail = feature('components/AuditDetailSheet.vue')
    expect(view).toContain('<AuditSummaryCards')
    expect(filters).toContain("from '@aurum/ui/select'")
    expect(filters).toContain("from '@aurum/ui/field'")
    expect(summary).toContain("from '@aurum/ui/card'")
    expect(table).toContain('<Table>')
    expect(table).toContain('<Empty')
    expect(detail).toContain('<Sheet')
    expect(detail).toContain('<ScrollArea')
    expect(detail).toContain('<Separator')
  })

  it('persists account filters and opens source deep links from the URL', () => {
    const view = feature('views/AuditView.vue')
    expect(view).toContain('route.query.account_id')
    expect(view).toContain('route.query.category')
    expect(view).toContain('route.query.status')
    expect(view).toContain('route.query.actor')
    expect(view).toContain('route.query.source_kind')
    expect(view).toContain('route.query.source_id')
    expect(view).toContain('workspace.loadDetail(kind, id)')
  })

  it('keeps mobile records operable without horizontal overflow', () => {
    const view = feature('views/AuditView.vue')
    const table = feature('components/AuditEventTable.vue')
    expect(view).toContain('overflow-x-hidden')
    expect(table).toContain('lg:hidden')
    expect(table).toContain('min-h-28')
    expect(table).toContain('whitespace-normal')
    expect(table).toContain('formatAuditTimestamp(')
  })

  it('subscribes to lightweight user-scoped audit invalidations only', () => {
    const realtime = feature('realtime/audit-realtime.ts')
    expect(realtime).toContain("kind: 'audit'")
    expect(realtime).toContain('trading_account_id: null')
    expect(realtime).toContain("resource_id: 'all'")
    expect(realtime).toContain("messageType === 'subscription.ready'")
    expect(realtime).toContain("messageType === 'subscription.resync_required'")
    expect(realtime).toContain("item?.type === 'audit.changed'")
    expect(realtime).toContain('scope.user_id !== input.session.user.id')
    expect(realtime).toContain('scope.trading_account_id !== null')
    expect(realtime).toContain('input.resync()')
    expect(realtime).not.toContain('const revisions = new Map')
    expect(realtime).not.toContain('numericRevision')
    expect(realtime).not.toContain('items:')
    expect(realtime).not.toContain('trace:')
  })
})
