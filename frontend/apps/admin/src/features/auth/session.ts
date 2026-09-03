import { computed, ref } from 'vue'
import { createApiClient } from '@aurum/api-client'
import type { SessionSummary } from '@aurum/contracts'

const client = createApiClient()
const session = ref<SessionSummary | null>(null)
const loading = ref(false)

export function useAdminSession() {
  async function load() {
    loading.value = true
    try {
      const response = await client.getSession()
      session.value = response.data.permissions.includes('admin') ? response.data : null
      return session.value
    } catch {
      session.value = null
      return null
    } finally {
      loading.value = false
    }
  }

  async function logout() {
    if (!session.value) return
    await client.logoutCurrent(session.value.csrf_token)
    session.value = null
  }

  return {
    session,
    loading: computed(() => loading.value),
    displayName: computed(() => session.value?.user.display_name ?? '待登录'),
    load,
    logout,
  }
}
