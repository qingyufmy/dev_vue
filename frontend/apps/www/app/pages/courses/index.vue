<script setup lang="ts">
import { learningListSchema, type LearningCourse } from '@aurum/contracts'
import { formatBeijingTime } from '@aurum/ui/lib/time'
import { Button } from '@aurum/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@aurum/ui/card'
import { Badge } from '@aurum/ui/badge'
useSeoMeta({ title: '课程｜量见', description: '查看量见课程与学习内容。' })
const items = ref<LearningCourse[]>([])
const cursor = ref<string | null>(null)
const pending = ref(false)
const error = ref(false)
async function load(reset = false) {
  if (pending.value) return
  pending.value = true; error.value = false
  try {
    const response = await $fetch<{ data: unknown }>('/api/v4/learning/courses', { query: !reset && cursor.value ? { cursor: cursor.value } : {} })
    const page = learningListSchema.parse(response.data)
    items.value = reset ? page.items : [...items.value, ...page.items.filter(item => !items.value.some(current => current.id === item.id))]
    cursor.value = page.next_cursor
  } catch { error.value = true } finally { pending.value = false }
}
const accessLabel = (value: LearningCourse['access_level']) => ({ free: '免费课程', logged_in: '登录后学习', plus_pro: 'Plus / Pro 课程', pro_only: 'Pro 课程' })[value ?? 'logged_in']
onMounted(() => load(true))
</script>
<template>
  <section class="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8" :aria-busy="pending">
    <div class="mb-8 max-w-2xl"><p class="mb-2 text-sm text-muted-foreground">量见学堂</p><h1 class="text-3xl font-semibold tracking-tight">课程</h1><p class="mt-3 text-muted-foreground">选择课程，继续你的学习进度。</p></div>
    <p v-if="pending && !items.length" role="status" class="py-12 text-muted-foreground">正在加载课程…</p>
    <div v-if="error" role="alert" class="mb-6 flex flex-wrap items-center gap-4 rounded-lg border p-4"><p>课程暂时无法加载。</p><Button variant="outline" :disabled="pending" @click="load(!items.length)">重试</Button></div>
    <p v-if="!pending && !error && !items.length" class="rounded-lg border p-8 text-muted-foreground">暂时没有已发布的课程。</p>
    <div class="grid gap-5 md:grid-cols-2 lg:grid-cols-3">
      <Card v-for="item in items" :key="item.id" class="flex flex-col shadow-none">
        <CardHeader><Badge variant="secondary" class="mb-2 w-fit">{{ accessLabel(item.access_level) }}</Badge><CardTitle class="text-xl leading-7">{{ item.title }}</CardTitle><CardDescription v-if="item.category">{{ item.category }}</CardDescription></CardHeader>
        <CardContent class="flex flex-1 flex-col gap-5"><p class="line-clamp-3 text-sm leading-6 text-muted-foreground">{{ item.description || '打开课程查看学习内容。' }}</p><p v-if="item.updated_at" class="mt-auto text-xs text-muted-foreground">更新于 {{ formatBeijingTime(item.updated_at) }} · 北京时间</p><Button as-child variant="outline" class="w-full"><NuxtLink :to="`/courses/${item.id}`">查看课程<span class="sr-only">：{{ item.title }}</span></NuxtLink></Button></CardContent>
      </Card>
    </div>
    <Button v-if="cursor" class="mt-8" variant="outline" :disabled="pending" @click="load()">{{ pending ? '正在加载…' : '加载更多' }}</Button>
  </section>
</template>
