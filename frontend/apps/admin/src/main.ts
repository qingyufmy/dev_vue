import '@aurum/design-tokens/styles.css'

import { VueQueryPlugin } from '@tanstack/vue-query'
import { createPinia } from 'pinia'
import { createApp } from 'vue'

import App from './App.vue'
import { router } from './router'

document.documentElement.dataset.surface = 'admin'

createApp(App)
  .use(createPinia())
  .use(VueQueryPlugin)
  .use(router)
  .mount('#app')
