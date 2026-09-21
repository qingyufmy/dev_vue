<script setup lang="ts">
import { NotificationBell, personalSettings } from '~/features/personal'
import { ContextCommandRecovery, tradingContext } from '~/features/trading-context'
import { RuntimeStatus, OnlineAccountSwitcher, HeaderClock, MobileNavigation, ThemeToggle } from '~/features/shell'

import {
  BarChart3,
  BookOpenCheck,
  Bot,
  BrainCircuit,
  Cable,
  ChevronDown,
  History,
  House,
  LogOut,
  ScrollText,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
} from '@lucide/vue'
import { ref, watch, onBeforeUnmount } from 'vue'
import { createApiClient } from '@aurum/api-client'
import { applyPublicDisplayClock, applyPublicMarketStates } from '~/features/trading-context'
import { RouterLink, RouterView, useRoute } from 'vue-router'
import { Avatar, AvatarFallback } from '@aurum/ui/avatar'
import { Button } from '@aurum/ui/button'
import { Alert, AlertDescription, AlertTitle } from '@aurum/ui/alert'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@aurum/ui/dropdown-menu'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from '@aurum/ui/sidebar'
import { Toaster } from '@aurum/ui/sonner'
import { useTradeSession } from '~/features/auth'


const route = useRoute()
const mobileStatusOpen = ref(false)
watch(() => route.path, () => { mobileStatusOpen.value = false })
const { displayName, logout, session } = useTradeSession()
const clockClient = createApiClient()
let clockTimer: ReturnType<typeof setTimeout> | undefined
let clockVersion = 0
watch(() => JSON.stringify([session.value?.user.id, session.value?.authenticated_at]), async () => {
  const version = ++clockVersion
  clearTimeout(clockTimer)
  applyPublicDisplayClock(null)
  applyPublicMarketStates([])
  if (!session.value) return
  async function refreshClock() {
    try {
      const result = await clockClient.getPublicMarketSymbols()
      if (version !== clockVersion) return
      applyPublicDisplayClock(result.data.timezone ?? null)
      applyPublicMarketStates(result.data.market_states ?? [])
    } catch { /* Keep the last display value during a temporary network failure. */ }
    if (version === clockVersion) clockTimer = setTimeout(refreshClock, 15000)
  }
  await refreshClock()
}, { immediate: true })
onBeforeUnmount(() => { clockVersion++; clearTimeout(clockTimer) })
const logoutPending = ref(false)
const logoutError = ref('')

async function logoutCurrent() {
  if (logoutPending.value) return
  logoutPending.value = true
  logoutError.value = ''
  try {
    await logout()
    window.location.assign('/login?reason=signed-out')
  } catch {
    logoutError.value = '退出尚未确认，请检查网络后重试。'
  } finally {
    logoutPending.value = false
  }
}

const navGroups = [
  {
    label: '交易工作区',
    items: [
      { to: '/', label: '首页', icon: House },
      { to: '/analyst', label: 'AI 分析师', icon: BarChart3 },
      { to: '/trader', label: 'AI 交易员', icon: SlidersHorizontal },
      { to: '/risk', label: 'AI 风控师', icon: ShieldCheck },
      { to: '/strategist', label: 'AI 策略师', icon: BrainCircuit },
      { to: '/reviewer', label: 'AI 复盘师', icon: BookOpenCheck },
    ],
  },
  {
    label: '记录',
    items: [
      { to: '/trades', label: '交易记录', icon: History },
      { to: '/audit', label: '系统审计', icon: ScrollText },
    ],
  },
]
</script>

<template>
  <RouterView v-if="route.meta.public" />
  <SidebarProvider v-else :default-open="true" :style="{ '--sidebar-width-icon': '4rem' }">
    <Sidebar collapsible="icon">
      <SidebarHeader class="border-b p-3 group-data-[collapsible=icon]:px-0">
        <RouterLink to="/" aria-label="AI 交易实验室首页" class="flex min-h-12 items-center gap-3 rounded-lg px-2 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0 focus-visible:outline-2 focus-visible:outline-ring">
          <span class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
            <Bot class="size-5" aria-hidden="true" />
          </span>
          <span class="grid leading-tight group-data-[collapsible=icon]:hidden">
            <strong class="text-sm">AI 交易实验室</strong>
            <span class="text-xs text-muted-foreground">量见</span>
          </span>
        </RouterLink>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup v-for="group in navGroups" :key="group.label">
          <SidebarGroupLabel class="group-data-[collapsible=icon]:hidden">{{ group.label }}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem v-for="item in group.items" :key="item.to" class="group-data-[collapsible=icon]:mx-auto">
                <SidebarMenuButton as-child :is-active="route.path === item.to" :tooltip="item.label" size="lg">
                  <RouterLink :to="item.to" :aria-label="item.label">
                    <component :is="item.icon" aria-hidden="true" />
                    <span class="group-data-[collapsible=icon]:hidden">{{ item.label }}</span>
                  </RouterLink>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter class="border-t p-3">
        <SidebarMenu>
          <SidebarMenuItem class="group-data-[collapsible=icon]:mx-auto">
            <SidebarMenuButton as-child :is-active="route.path === '/bridge'" tooltip="量见智桥" size="lg">
              <RouterLink to="/bridge" aria-label="量见智桥">
                <Cable aria-hidden="true" />
                <span class="group-data-[collapsible=icon]:hidden">量见智桥</span>
              </RouterLink>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>

    <SidebarInset class="h-dvh overflow-hidden">
      <header class="flex min-h-16 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b bg-background px-3 py-2 pt-[max(0.5rem,env(safe-area-inset-top))] sm:px-5">
        <SidebarTrigger class="hidden size-11 shrink-0 md:inline-flex" aria-label="展开或收起导航" />
        <Button variant="ghost" class="h-11 gap-1 px-1 text-sm md:hidden" :aria-expanded="mobileStatusOpen" aria-controls="header-runtime-status" aria-label="展开运行状态" @click="mobileStatusOpen = !mobileStatusOpen">状态<ChevronDown class="size-4" :class="mobileStatusOpen ? 'rotate-180' : ''" /></Button>
        <RuntimeStatus id="header-runtime-status" class="order-3 w-full md:order-none md:flex md:w-auto md:min-w-0 md:flex-1" :class="mobileStatusOpen ? 'flex border-t pt-2 md:border-0 md:pt-0' : 'hidden'" />


        <OnlineAccountSwitcher />
        <HeaderClock />
        <NotificationBell />
        <ThemeToggle />

        <DropdownMenu>
          <DropdownMenuTrigger as-child>
            <Button variant="ghost" class="h-11 gap-2 rounded-lg px-3 sm:ml-0" aria-label="打开账户与设置菜单">
              <Avatar size="sm">
                <AvatarFallback>{{ displayName?.slice(0, 1) || '客' }}</AvatarFallback>
              </Avatar>
              <span class="hidden max-w-24 truncate text-sm sm:inline">{{ personalSettings?.nickname || displayName }}</span>
              <ChevronDown class="size-4 text-muted-foreground" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" class="w-52">
            <DropdownMenuGroup>
            <DropdownMenuLabel>账户与设置</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem as-child>
              <RouterLink to="/settings/personal"><Settings2 />个人设置</RouterLink>
            </DropdownMenuItem>
            <DropdownMenuItem as-child>
              <RouterLink to="/settings/models"><Settings2 />模型配置</RouterLink>
            </DropdownMenuItem>
            <DropdownMenuItem as-child>
              <RouterLink to="/bridge"><Cable />量见智桥</RouterLink>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem :disabled="logoutPending" @select="logoutCurrent"><LogOut />退出交易实验室</DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>
      <Alert v-if="logoutError" variant="destructive" role="alert"><AlertTitle>退出未完成</AlertTitle><AlertDescription>{{ logoutError }}</AlertDescription></Alert>

      <ContextCommandRecovery />
      <main class="min-h-0 flex-1 overflow-y-auto">
        <RouterView :key="`${tradingContext?.mode}:${tradingContext?.accountId}:${tradingContext?.observerChannelId}`" />
      </main>
      <MobileNavigation :groups="navGroups" />
    </SidebarInset>
    <Toaster class="pointer-events-auto" position="top-right" close-button close-button-position="top-right" />
  </SidebarProvider>
</template>
