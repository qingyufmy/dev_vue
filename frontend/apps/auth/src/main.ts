import { createApp } from 'vue'
import '@aurum/design-tokens/styles.css'
import App from './App.vue'

document.documentElement.dataset.surface = 'auth'
createApp(App).mount('#app')
