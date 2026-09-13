<script setup lang="ts">
import {
  BellRing,
  Blocks,
  Bot,
  BrainCircuit,
  Cable,
  ChevronDown,
  CircleUserRound,
  Coins,
  FileClock,
  Gauge,
  Globe2,
  GraduationCap,
  LogOut,
  Settings2,
  ShieldCheck,
  UsersRound,
} from '@lucide/vue'
import { computed, ref } from 'vue'
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
import { useAdminSession } from '~/features/auth'

const route = useRoute()
const pageTitle = computed(() => String(route.meta.title ?? '管理后台'))
const { displayName, logout } = useAdminSession()
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
    label: '运营',
    items: [
      { to: '/', label: '运营概览', icon: Gauge },
      { to: '/users', label: '用户与会员', icon: UsersRound },
      { to: '/content', label: '内容与课程', icon: GraduationCap },
      { to: '/commercial', label: '商业与订单', icon: Coins },
      { to: '/notifications', label: '通知中心', icon: BellRing },
    ],
  },
  {
    label: '交易平台',
    items: [
      { to: '/strategies', label: '策略管理', icon: BrainCircuit },
      { to: '/models', label: '共享模型', icon: Bot },
      { to: '/risk', label: '平台风控', icon: ShieldCheck },
      { to: '/bridge', label: 'Bridge 运营', icon: Cable },
    ],
  },
  {
    label: '系统',
    items: [
      { to: '/site-settings', label: '站点与域名', icon: Globe2 },
      { to: '/audit', label: '审计日志', icon: FileClock },
      { to: '/system', label: '系统设置', icon: Settings2 },
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
            <Blocks class="size-5" aria-hidden="true" />
          </span>
          <span class="grid leading-tight group-data-[collapsible=icon]:hidden">
            <strong class="text-sm">量见管理后台</strong>
            <span class="text-xs text-muted-foreground">运营与平台治理</span>
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
        <p class="px-2 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">量见管理后台</p>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>

    <SidebarInset class="h-svh overflow-hidden">
      <header class="flex h-16 shrink-0 items-center gap-3 border-b bg-background px-3 sm:px-5">
        <SidebarTrigger class="size-11 shrink-0" aria-label="展开或收起导航" />
        <div class="min-w-0 flex-1">
          <p class="truncate text-sm font-semibold">{{ pageTitle }}</p>
          <p class="hidden text-xs text-muted-foreground sm:block">管理操作将显示明确作用范围并写入审计</p>
        </div>

        <Button variant="ghost" size="icon" aria-label="通知中心" as-child>
          <RouterLink to="/notifications"><BellRing /></RouterLink>
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger as-child>
            <Button variant="ghost" class="h-11 gap-2 px-2" aria-label="打开管理员账户菜单">
              <Avatar size="sm"><AvatarFallback>管</AvatarFallback></Avatar>
              <span class="hidden max-w-24 truncate text-sm sm:inline">{{ displayName }}</span>
              <ChevronDown class="size-4 text-muted-foreground" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" class="w-48">
            <DropdownMenuGroup>
            <DropdownMenuLabel>管理员账户</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled><CircleUserRound />账户资料</DropdownMenuItem>
            <DropdownMenuItem as-child><RouterLink to="/system"><Settings2 />系统设置</RouterLink></DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem :disabled="logoutPending" @select="logoutCurrent"><LogOut />退出管理后台</DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>
      <Alert v-if="logoutError" variant="destructive" role="alert"><AlertTitle>退出未完成</AlertTitle><AlertDescription>{{ logoutError }}</AlertDescription></Alert>

      <main class="min-h-0 flex-1 overflow-y-auto">
        <RouterView />
      </main>
    </SidebarInset>
    <Toaster />
  </SidebarProvider>
</template>
