import { computed, readonly, ref } from 'vue'
import { ApiClientError, createApiClient } from '@aurum/api-client'
import type { SessionSummary } from '@aurum/contracts'
import { clearLoginAttempt } from './login-entry'

const client = createApiClient()
const session = ref<SessionSummary | null>(null)
const loading = ref(false)
const issue = ref<'none' | 'signed-out' | 'forbidden' | 'unavailable'>('none')
let generation = 0

export function useTradeSession() {
  async function load() {
    const request = ++generation
    loading.value = true
    try {
      const response = (await client.getSession()).data
      if (request !== generation) return null
      session.value = response
      issue.value = 'none'
      clearLoginAttempt()
      return readonly(session).value
    } catch (error) {
      if (request !== generation) return null
      session.value = null
      issue.value = error instanceof ApiClientError && error.status === 401 ? 'signed-out'
        : error instanceof ApiClientError && error.status === 403 ? 'forbidden' : 'unavailable'
      return null
    } finally {
      if (request === generation) loading.value = false
    }
  }

  async function logout() {
    const current = session.value
    if (!current) return
    ++generation
    loading.value = false
    await client.logoutCurrent(current.csrf_token)
    ++generation
    session.value = null
    issue.value = 'signed-out'
    clearLoginAttempt()
  }

  return {
    session: readonly(session),
    issue: readonly(issue),
    loading: computed(() => loading.value),
    displayName: computed(() => session.value?.user.display_name ?? '待登录'),
    load,
    logout,
  }
}
