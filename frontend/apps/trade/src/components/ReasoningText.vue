<script setup lang="ts">
import { computed } from 'vue'
const props = defineProps<{ text: string }>()
const terms: Record<string, string> = {
  entryEvidence: '入场依据', unavailable: '不可用', reversal_watch: '反转观察',
  marginLevelPercent: '保证金水平', drawdownPercent: '回撤比例',
  entry_structure_usable: '入场结构可用', false: '否', true: '是',
  manage: '持仓管理', 'market.events': '市场事件',
}
const blocks = computed(() => props.text.split(/\r?\n/).filter(line => line.trim()).map(line => {
  const heading = /^\s*#{1,6}\s+/.test(line)
  const bullet = /^\s*[-*]\s+/.test(line)
  const text = line.replace(/^\s*#{1,6}\s+|^\s*[-*]\s+/g, '').replace(/`([^`]+)`/g, '$1')
    .replace(/\b(?:entryEvidence|unavailable|reversal_watch|marginLevelPercent|drawdownPercent|entry_structure_usable|false|true|manage|market\.events)\b/g, key => terms[key] ?? key)
  return { heading, bullet, parts: text.split(/(\*\*[^*]+\*\*)/g).map(value => ({ bold: value.startsWith('**') && value.endsWith('**'), text: value.replace(/^\*\*|\*\*$/g, '') })) }
}))
</script>

<template>
  <div class="grid min-w-0 gap-3 [overflow-wrap:anywhere] break-words text-sm leading-7 text-foreground/90">
    <component :is="block.heading ? 'h3' : 'p'" v-for="(block, index) in blocks" :key="index" class="min-w-0" :class="[block.heading ? 'mt-4 border-b pb-2 font-semibold text-foreground first:mt-0' : '', block.bullet ? 'relative pl-4 before:absolute before:left-0 before:top-3 before:size-1 before:rounded-full before:bg-muted-foreground' : '']">
      <template v-for="(part, partIndex) in block.parts" :key="partIndex"><strong v-if="part.bold" class="font-semibold text-foreground">{{ part.text }}</strong><template v-else>{{ part.text }}</template></template>
    </component>
  </div>
</template>
