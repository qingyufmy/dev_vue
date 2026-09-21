<script lang="ts" setup>
import type { ToasterProps } from 'vue-sonner'

import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
  XIcon,
} from '@lucide/vue'
import { reactiveOmit } from '@vueuse/core'
import { Toaster as Sonner } from 'vue-sonner'
import 'vue-sonner/style.css'
import { cn } from '@/lib/utils'

const props = defineProps<ToasterProps>()
const delegatedProps = reactiveOmit(props, 'class', 'toastOptions')
</script>

<template>
  <Sonner
    :class="cn('toaster group', props.class)"
    :style="{
      '--normal-bg': 'var(--popover)',
      '--normal-text': 'var(--popover-foreground)',
      '--normal-border': 'var(--border)',
      '--border-radius': 'var(--radius)',
      '--gray2': 'hsl(var(--popover) / 0.9)',
      '--gray3': 'var(--border)',
      '--gray4': 'var(--border)',
      '--gray5': 'var(--border)',
      '--gray12': 'var(--popover-foreground)',
    }"
    :toast-options="props.toastOptions ?? {
      closeButtonAriaLabel: '关闭通知',
      classes: {
        toast: 'rounded-xl',
      },
    }"
    v-bind="delegatedProps"
  >
    <template #success-icon>
      <CircleCheckIcon class="size-4" />
    </template>
    <template #info-icon>
      <InfoIcon class="size-4" />
    </template>
    <template #warning-icon>
      <TriangleAlertIcon class="size-4" />
    </template>
    <template #error-icon>
      <OctagonXIcon class="size-4" />
    </template>
    <template #loading-icon>
      <div>
        <Loader2Icon class="size-4 animate-spin" />
      </div>
    </template>
    <template #close-icon>
      <XIcon class="size-4" />
    </template>
  </Sonner>
</template>

<style>
.toaster[data-sonner-toaster] [data-sonner-toast][data-styled='true'] {
  gap: 0.75rem;
  padding: 0.875rem 1rem;
  background: var(--popover) !important;
  border-color: var(--border) !important;
  border-left-width: 3px;
  border-radius: var(--radius) !important;
  color: var(--popover-foreground) !important;
  box-shadow: 0 18px 48px oklch(0 0 0 / 28%), 0 1px 0 oklch(1 0 0 / 5%);
}

.toaster[data-sonner-toaster] [data-sonner-toast][data-type='success'] {
  border-left-color: var(--system-ok) !important;
}

.toaster[data-sonner-toaster] [data-sonner-toast][data-type='info'] {
  border-left-color: var(--primary) !important;
}

.toaster[data-sonner-toaster] [data-sonner-toast][data-type='warning'] {
  border-left-color: var(--system-warn) !important;
}

.toaster[data-sonner-toaster] [data-sonner-toast][data-type='error'] {
  border-left-color: var(--destructive) !important;
}

.toaster[data-sonner-toaster] [data-sonner-toast] [data-title] {
  font-size: 0.875rem;
  font-weight: 600;
}

.toaster[data-sonner-toaster] [data-sonner-toast] [data-description] {
  color: var(--muted-foreground) !important;
  font-size: 0.8125rem;
  line-height: 1.5;
}

.toaster[data-sonner-toaster] [data-sonner-toast] [data-icon] {
  align-self: flex-start;
  margin-top: 0.125rem;
  color: var(--muted-foreground);
}

.toaster[data-sonner-toaster] [data-sonner-toast][data-type='success'] [data-icon] {
  color: var(--system-ok);
}

.toaster[data-sonner-toaster] [data-sonner-toast][data-type='info'] [data-icon] {
  color: var(--primary);
}

.toaster[data-sonner-toaster] [data-sonner-toast][data-type='warning'] [data-icon] {
  color: var(--system-warn);
}

.toaster[data-sonner-toaster] [data-sonner-toast][data-type='error'] [data-icon] {
  color: var(--destructive);
}

.toaster[data-sonner-toaster] [data-sonner-toast] [data-button] {
  height: 2rem;
  padding-inline: 0.75rem;
  background: var(--secondary) !important;
  border: 1px solid var(--border);
  border-radius: calc(var(--radius) - 0.25rem);
  color: var(--secondary-foreground) !important;
  transition-duration: 180ms;
  transition-property: color, background-color, border-color, box-shadow;
}

.toaster[data-sonner-toaster] [data-sonner-toast] [data-button]:hover {
  background: var(--accent) !important;
  color: var(--accent-foreground) !important;
}

.toaster[data-sonner-toaster] [data-sonner-toast] [data-button]:focus-visible,
.toaster[data-sonner-toaster] [data-sonner-toast] [data-close-button]:focus-visible {
  box-shadow: 0 0 0 2px var(--ring);
}

.toaster[data-sonner-toaster] [data-sonner-toast] [data-close-button] {
  background: var(--popover) !important;
  border-color: var(--border) !important;
  color: var(--muted-foreground) !important;
}

.toaster[data-sonner-toaster] [data-sonner-toast] [data-close-button]:hover {
  background: var(--accent) !important;
  color: var(--accent-foreground) !important;
}
</style>
