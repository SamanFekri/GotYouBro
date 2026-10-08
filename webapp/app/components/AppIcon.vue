<script setup lang="ts">
import {
  Activity,
  BookOpen,
  Boxes,
  ChevronRight,
  CircleAlert,
  ExternalLink,
  HeartPulse,
  House,
  Inbox,
  KeyRound,
  Menu,
  Package,
  ScrollText,
  Send,
  Settings,
  ShieldBan,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  TriangleAlert,
  Users,
  X,
} from 'lucide-vue-next';

/** Every icon the app uses, by name — one place to keep the set consistent. */
const icons = {
  activity: Activity,
  admin: ShieldCheck,
  alert: CircleAlert,
  blocked: ShieldBan,
  chevron: ChevronRight,
  close: X,
  destination: Send,
  docs: BookOpen,
  empty: Inbox,
  external: ExternalLink,
  heartbeat: HeartPulse,
  home: House,
  key: KeyRound,
  menu: Menu,
  package: Package,
  scroll: ScrollText,
  services: Boxes,
  settings: Settings,
  sliders: SlidersHorizontal,
  telegram: Send,
  trash: Trash2,
  users: Users,
  warning: TriangleAlert,
} as const;

export type IconName = keyof typeof icons;

withDefaults(defineProps<{ name: IconName; size?: number; strokeWidth?: number }>(), { size: 20, strokeWidth: 2 });
</script>

<template>
  <component :is="icons[name]" :size="size" :stroke-width="strokeWidth" class="app-icon" aria-hidden="true" />
</template>

<style scoped>
.app-icon {
  flex-shrink: 0;
}
</style>
