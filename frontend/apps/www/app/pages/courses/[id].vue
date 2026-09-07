<script setup lang="ts">
import { learningDetailSchema } from '@aurum/contracts'
import { formatBeijingTime } from '@aurum/ui/lib/time'
import { Button } from '@aurum/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@aurum/ui/card'
import { useLearningCompletion } from '../../composables/use-learning-completion'
const route = useRoute()
const id = computed(() => String(route.params.id ?? ''))
const { data, status, error, refresh, clear } = await useAsyncData(() => `learning-course-${id.value}`, async () => {
  const response = await $fetch<{ data: unknown }>(`/api/v4/learning/courses/${encodeURIComponent(id.value)}`)
  return learningDetailSchema.parse(response.data)
}, { server: false })
const loginLink = computed(() => `/login?next=${encodeURIComponent(`/courses/${id.value}`)}`)
useSeoMeta({ title: () => `${data.value?.course.title ?? '课程'}｜量见`, robots: 'noindex, nofollow' })
const duration = (ms: string | null) => ms === null ? '时长待补充' : `${BigInt(ms) / 60000n} 分钟`
const completion = useLearningCompletion(() => ({ courseId: id.value, viewerUserId: data.value?.viewer_user_id ?? null }), async (invalidate = false) => {
  if (invalidate) clear()
  await refresh()
  if (error.value) throw error.value
})
</script>
<template>
  <section class="mx-auto max-w-4xl px-4 py-12 sm:px-6" :aria-busy="status === 'pending'">
    <NuxtLink to="/courses" class="mb-6 inline-flex min-h-11 items-center text-sm text-muted-foreground hover:text-foreground">← 返回课程列表</NuxtLink>
    <p v-if="status === 'pending' && !data" role="status">正在加载课程…</p>
    <div v-else-if="error" role="alert" class="grid gap-4 rounded-lg border p-6"><p>课程暂时不可用，请重新登录或稍后重试。</p><div class="flex gap-3"><Button variant="outline" @click="refresh()">重试</Button><Button as-child><NuxtLink :to="loginLink">登录</NuxtLink></Button></div></div>
    <template v-else-if="data">
      <h1 class="text-3xl font-semibold tracking-tight">{{ data.course.title }}</h1>
      <p class="mt-5 whitespace-pre-line text-muted-foreground">{{ data.course.description }}</p>
      <p v-if="data.course.updated_at" class="mt-4 text-xs text-muted-foreground">更新于 {{ formatBeijingTime(data.course.updated_at) }} · 北京时间</p>
      <div v-if="data.access !== 'allowed'" class="mt-8 grid gap-4 rounded-lg border p-6"><p>{{ data.access === 'login_required' ? '登录后查看课程内容和你的学习进度。' : '当前会员权限无法查看这门课程。' }}</p><Button v-if="data.access === 'login_required'" as-child class="w-fit"><NuxtLink :to="loginLink">登录并继续学习</NuxtLink></Button></div>
      <div v-else class="mt-8 grid gap-5">
        <p v-if="!data.lessons.length" class="rounded-lg border p-6 text-muted-foreground">课节正在准备中。</p>
        <Card v-for="lesson in data.lessons" :key="lesson.id" class="shadow-none">
          <CardHeader><CardTitle class="text-lg">{{ lesson.title }}</CardTitle></CardHeader>
          <CardContent class="grid gap-4">
            <p class="text-sm text-muted-foreground">{{ duration(lesson.duration_ms) }}</p>
            <p v-if="lesson.progress" class="text-sm">
              {{ lesson.progress.completed ? '已完成' : '学习中' }}
              <template v-if="lesson.progress.watched_ms !== null"> · 已观看 {{ duration(lesson.progress.watched_ms) }}</template>
              <span v-if="lesson.progress.updated_at" class="mt-1 block text-xs text-muted-foreground">最近学习 {{ formatBeijingTime(lesson.progress.updated_at) }} · 北京时间</span>
            </p>
            <div class="flex flex-wrap gap-3">
              <Button v-for="resource in lesson.resources" :key="resource.kind" as-child variant="outline"><a :href="resource.url" target="_blank" rel="noopener noreferrer">{{ resource.kind === 'bilibili_id' ? '在哔哩哔哩打开' : resource.kind === 'youtube_id' ? '在 YouTube 打开' : '打开课程内容' }}<span class="sr-only">（新窗口）</span></a></Button>
            </div>
            <p v-if="!lesson.resources.length" class="text-sm text-muted-foreground">课程资源暂未就绪。</p>
            <div class="grid gap-2 border-t pt-4">
              <template v-if="data.viewer_user_id">
                <Button class="min-h-11 w-fit aria-disabled:cursor-wait aria-disabled:opacity-60" variant="outline" :aria-disabled="completion.stateFor(lesson.id).phase === 'saving'" :aria-busy="completion.stateFor(lesson.id).phase === 'saving'" @click="completion.save(lesson)">
                  {{ completion.stateFor(lesson.id).phase === 'saving' ? '正在处理…' : completion.stateFor(lesson.id).phase === 'uncertain' ? '确认保存结果' : completion.stateFor(lesson.id).phase === 'reload' ? '刷新学习记录' : lesson.progress?.completed ? '取消完成标记' : '标记已学完' }}
                </Button>
                <p v-if="completion.stateFor(lesson.id).message" role="status" aria-live="polite" class="text-sm text-muted-foreground">{{ completion.stateFor(lesson.id).message }}</p>
                <p class="text-xs text-muted-foreground">完成标记由你手动确认，观看时长保持原记录。</p>
              </template>
              <Button v-else as-child class="min-h-11 w-fit" variant="outline"><NuxtLink :to="loginLink">登录后保存学习记录</NuxtLink></Button>
            </div>
          </CardContent>
        </Card>
        <p v-if="data.lessons_truncated" class="text-sm text-muted-foreground">当前显示前 100 节课。</p>
      </div>
    </template>
  </section>
</template>
