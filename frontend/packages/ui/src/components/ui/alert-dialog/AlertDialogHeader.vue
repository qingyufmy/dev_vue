<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { cn } from '@/lib/utils'
defineProps<{ class?: HTMLAttributes['class'] }>()
</script>
<template><div data-slot="alert-dialog-header" :class="cn('grid gap-2 text-left', $props.class)"><slot /></div></template>
