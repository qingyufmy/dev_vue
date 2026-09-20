<script setup lang="ts">
import { Moon, Sun } from '@lucide/vue'
import { Button } from '@aurum/ui/button'
import { ref } from 'vue'

const light = ref(document.documentElement.dataset.theme === 'light')
function toggle() {
  light.value = !light.value
  const theme = light.value ? 'light' : 'dark'
  document.documentElement.dataset.theme = theme
  document.documentElement.classList.toggle('dark', !light.value)
  try { localStorage.setItem('aurum-trade-theme', theme) } catch { /* Theme still works for this page. */ }
}
</script>

<template>
  <Button variant="ghost" size="icon" class="size-10 shrink-0" :aria-label="light ? '切换深色模式' : '切换浅色模式'" :title="light ? '切换深色模式' : '切换浅色模式'" @click="toggle">
    <Moon v-if="light" class="size-4" /><Sun v-else class="size-4" />
  </Button>
</template>
