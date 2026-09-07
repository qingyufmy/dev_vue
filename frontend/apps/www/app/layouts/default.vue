<script setup lang="ts">
import { ArrowRight, ChartNoAxesCombined } from '@lucide/vue'
import { Button } from '@aurum/ui/button'
</script>

<template>
  <div data-surface="www" class="min-h-svh bg-background text-foreground">
    <header class="sticky top-0 z-30 border-b bg-background/95">
      <div class="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
        <NuxtLink to="/" class="flex min-h-11 items-center gap-3 rounded-md focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring">
          <span class="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <ChartNoAxesCombined class="size-5" aria-hidden="true" />
          </span>
          <span class="font-semibold tracking-tight">量见</span>
        </NuxtLink>

        <nav aria-label="主导航" class="hidden items-center gap-7 text-sm text-muted-foreground md:flex">
          <NuxtLink to="/courses" class="hover:text-foreground">课程</NuxtLink>
          <NuxtLink to="/#solutions" class="hover:text-foreground">AI 交易实验室</NuxtLink>
          <NuxtLink to="/#about" class="hover:text-foreground">关于我们</NuxtLink>
        </nav>

        <div class="flex items-center gap-2">
          <Button as-child variant="ghost" class="hidden sm:inline-flex">
            <NuxtLink to="/login">登录</NuxtLink>
          </Button>
          <Button as-child>
            <NuxtLink to="/login">
              开始使用
              <ArrowRight data-icon="inline-end" />
            </NuxtLink>
          </Button>
        </div>
      </div>
    </header>

    <main>
      <slot />
    </main>

    <footer class="border-t py-10">
      <div class="mx-auto flex max-w-7xl flex-col gap-3 px-4 text-sm text-muted-foreground sm:px-6 md:flex-row md:items-center md:justify-between lg:px-8">
        <p>© 量见 · 让复杂交易判断更清晰</p>
        <div class="flex gap-5">
          <NuxtLink to="/legal/privacy" class="hover:text-foreground">隐私政策</NuxtLink>
          <NuxtLink to="/legal/terms" class="hover:text-foreground">用户协议</NuxtLink>
        </div>
      </div>
    </footer>
  </div>
</template>
