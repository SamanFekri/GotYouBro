<script setup lang="ts">
import type { AdminUser, Page } from '~/utils/types';

definePageMeta({ middleware: 'admin' });

const api = useApi();
const q = ref('');
const blockedOnly = ref(false);
const items = ref<AdminUser[]>([]);
const total = ref(0);
const loading = ref(false);

async function load(append = false) {
  loading.value = true;
  try {
    const page = await api.get<Page<AdminUser>>('/admin/users', { q: q.value, blocked: blockedOnly.value ? 'true' : undefined, limit: 50, offset: append ? items.value.length : 0 });
    items.value = append ? [...items.value, ...page.items] : page.items;
    total.value = page.total;
  } finally {
    loading.value = false;
  }
}
onMounted(() => load());
let debounce: ReturnType<typeof setTimeout>;
watch(q, () => {
  clearTimeout(debounce);
  debounce = setTimeout(() => load(), 300);
});
watch(blockedOnly, () => load());
</script>

<template>
  <div class="page">
    <div class="page-header"><NuxtLink to="/admin" class="btn ghost">‹ Admin</NuxtLink></div>
    <div class="spread"><h1>Users</h1><span class="hint">{{ total }}</span></div>
    <input v-model="q" class="input" placeholder="Search username, name or Telegram ID" />
    <label class="switch">Blocked only <input v-model="blockedOnly" type="checkbox" /></label>

    <div class="list">
      <NuxtLink v-for="u in items" :key="u.id" :to="`/admin/users/${u.id}`" class="list-item">
        <div class="grow">
          <div class="title">{{ [u.firstName, u.lastName].filter(Boolean).join(' ') || 'Unnamed' }} <span v-if="u.username" class="muted">@{{ u.username }}</span></div>
          <div class="sub"><span class="mono">{{ u.telegramId }}</span> · {{ u.serviceCount }} services · seen {{ timeAgo(u.lastSeenAt) }}</div>
        </div>
        <span v-if="u.blocked" class="badge bad"><span class="dot" />Blocked</span>
        <span v-else-if="u.isAdmin" class="badge info"><span class="dot" />Admin</span>
      </NuxtLink>
    </div>
    <div v-if="loading" class="spinner" />
    <button v-else-if="items.length < total" class="btn secondary block" @click="load(true)">Load more</button>
  </div>
</template>
