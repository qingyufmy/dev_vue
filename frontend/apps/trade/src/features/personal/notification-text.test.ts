import { expect, it } from 'vitest'
import { notificationText } from './notification-text'
it('translates complete internal terms without altering prices, symbols or unknown words', () => {
 expect(notificationText('任务模式为manage，H1/M15为reversal_watch，XAUUSD.s 4315.81，不提出modify_position。'))
  .toBe('任务模式为持仓管理，H1/M15为反转观察，XAUUSD.s 4315.81，不提出修改持仓保护价。')
 expect(notificationText('management hold_reason 829936702 EMA34')).toBe('management hold_reason 829936702 EMA34')
})
