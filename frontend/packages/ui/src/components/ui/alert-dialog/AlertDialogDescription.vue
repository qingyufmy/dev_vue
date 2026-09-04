<script setup lang="ts">
import type { AlertDialogDescriptionProps } from 'reka-ui'
import type { HTMLAttributes } from 'vue'
import { reactiveOmit } from '@vueuse/core'
import { AlertDialogDescription } from 'reka-ui'
import { cn } from '@/lib/utils'

const props = defineProps<AlertDialogDescriptionProps & { class?: HTMLAttributes['class'] }>()
const delegatedProps = reactiveOmit(props, 'class')
</script>

<template><AlertDialogDescription data-slot="alert-dialog-description" :class="cn('text-sm leading-6 text-muted-foreground', props.class)" v-bind="delegatedProps"><slot /></AlertDialogDescription></template>
