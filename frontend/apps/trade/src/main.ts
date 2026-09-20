import '@aurum/design-tokens/styles.css'

import { VueQueryPlugin } from '@tanstack/vue-query'
import { createPinia } from 'pinia'
import { createApp } from 'vue'

import App from './App.vue'
import { router } from './router'

document.documentElement.dataset.surface = 'trade'
try { document.documentElement.dataset.theme = localStorage.getItem('aurum-trade-theme') === 'light' ? 'light' : 'dark' } catch { document.documentElement.dataset.theme = 'dark' }
document.documentElement.classList.toggle('dark', document.documentElement.dataset.theme === 'dark')

createApp(App)
  .use(createPinia())
  .use(VueQueryPlugin)
  .use(router)
  .mount('#app')
