<script setup lang="ts">
import {
  BarChart3,
  BookOpenCheck,
  Bot,
  BrainCircuit,
  Cable,
  ChartCandlestick,
  ChevronDown,
  CircleUserRound,
  History,
  House,
  LogOut,
  ScrollText,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
} from '@lucide/vue'
import { computed } from 'vue'
import { activeTerminalDisplayTimezone } from '~/lib/laboratory-display-time'
import { RouterLink, RouterView, useRoute } from 'vue-router'
import { Avatar, AvatarFallback } from '@aurum/ui/avatar'
import { Badge } from '@aurum/ui/badge'
import { Button } from '@aurum/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
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
import { useTradeSession } from '~/features/auth/session'
import { currentAccount, realtimeState, tradingContext } from '~/features/home/home-runtime'

const displayTimezone = computed(activeTerminalDisplayTimezone)
const route = useRoute()
const pageTitle = computed(() => String(route.meta.title ?? 'AI 交易实验室'))
const { displayName, logout } = useTradeSession()

async function logoutCurrent() {
  await logout()
  window.location.assign('/login')
}

const navGroups = [
  {
    label: '交易工作区',
    items: [
      { to: '/', label: '首页', icon: House },
      { to: '/market', label: '市场行情', icon: ChartCandlestick },
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
  <SidebarProvider v-else :default-open="true">
    <Sidebar collapsible="icon">
      <SidebarHeader class="border-b p-3">
        <RouterLink to="/" class="flex min-h-12 items-center gap-3 rounded-lg px-2 focus-visible:outline-2 focus-visible:outline-ring">
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
          <SidebarGroupLabel>{{ group.label }}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem v-for="item in group.items" :key="item.to">
                <SidebarMenuButton as-child :is-active="route.path === item.to" :tooltip="item.label" size="lg">
                  <RouterLink :to="item.to">
                    <component :is="item.icon" aria-hidden="true" />
                    <span>{{ item.label }}</span>
                  </RouterLink>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter class="border-t p-3">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton as-child :is-active="route.path === '/bridge'" tooltip="量见智桥" size="lg">
              <RouterLink to="/bridge">
                <Cable aria-hidden="true" />
                <span>量见智桥</span>
              </RouterLink>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>

    <SidebarInset class="h-svh overflow-hidden">
      <header class="flex h-16 shrink-0 items-center gap-3 border-b bg-background px-3 sm:px-5">
        <SidebarTrigger class="shrink-0" />
        <div class="min-w-0 flex-1">
          <p class="truncate text-sm font-semibold">{{ pageTitle }}</p>
          <p class="truncate text-xs text-muted-foreground">终端时间 {{ displayTimezone.label }} · {{ displayTimezone.statusLabel }}</p>
        </div>

        <div class="hidden items-center gap-2 lg:flex" aria-label="运行状态">
          <Badge :variant="currentAccount?.bridgeState === 'online' ? 'default' : 'outline'">{{ currentAccount?.bridgeState === 'online' ? '智桥已连接' : '智桥未连接' }}</Badge>
          <Badge variant="outline">{{ realtimeState === 'live' ? '数据实时同步' : '快照模式' }}</Badge>
          <Badge :variant="currentAccount?.tradePermission && tradingContext?.mode !== 'observer' ? 'default' : 'secondary'">{{ tradingContext?.mode === 'observer' ? '观摩模式' : currentAccount?.tradePermission ? '交易已授权' : '只读' }}</Badge>
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger as-child>
            <Button variant="ghost" class="h-11 gap-2 px-2">
              <Avatar size="sm">
                <AvatarFallback>客</AvatarFallback>
              </Avatar>
              <span class="hidden max-w-24 truncate text-sm sm:inline">{{ displayName }}</span>
              <ChevronDown class="size-4 text-muted-foreground" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" class="w-52">
            <DropdownMenuLabel>账户与设置</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem as-child>
              <RouterLink to="/settings/models"><Settings2 />模型配置</RouterLink>
            </DropdownMenuItem>
            <DropdownMenuItem><CircleUserRound />用户中心</DropdownMenuItem>
            <DropdownMenuItem as-child>
              <RouterLink to="/bridge"><Cable />量见智桥</RouterLink>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem @select="logoutCurrent"><LogOut />退出交易实验室</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      <main class="min-h-0 flex-1 overflow-y-auto">
        <RouterView />
      </main>
    </SidebarInset>
    <Toaster />
  </SidebarProvider>
</template>
