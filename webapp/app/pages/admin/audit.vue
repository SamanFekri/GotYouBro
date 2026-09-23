<script setup lang="ts">
import type { Page } from '~/utils/types';

definePageMeta({ middleware: 'admin' });

interface AuditEntry {
  id: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown> | null;
  ip: string | null;
  createdAt: string;
  actorTelegramId: number | null;
  actorUsername: string | null;
}

const api = useApi();
const items = ref<AuditEntry[]>([]);
const total = ref(0);
const loading = ref(false);

async function load(append = false) {
  loading.value = true;
  try {
    const page = await api.get<Page<AuditEntry>>('/admin/audit-logs', { limit: 50, offset: append ? items.value.length : 0 });
    items.value = append ? [...items.value, ...page.items] : page.items;
    total.value = page.total;
  } finally {
    loading.value = false;
  }
}
onMounted(() => load());
</script>

<template>
  <div class="page">
    <div class="page-header"><NuxtLink to="/admin" class="btn ghost">‹ Admin</NuxtLink></div>
    <h1>Audit log</h1>
    <div class="list">
      <div v-for="e in items" :key="e.id" class="list-item" style="align-items: flex-start">
        <div class="grow">
          <div class="title mono">{{ e.action }}</div>
          <div class="sub">
            {{ e.actorUsername ? '@' + e.actorUsername : e.actorTelegramId ?? 'system' }}
            <template v-if="e.targetType"> → {{ e.targetType }} <span class="mono">{{ e.targetId }}</span></template>
          </div>
          <div v-if="e.metadata && Object.keys(e.metadata).length" class="sub mono" style="white-space: normal">{{ JSON.stringify(e.metadata) }}</div>
        </div>
        <span class="hint">{{ timeAgo(e.createdAt) }}</span>
      </div>
    </div>
    <EmptyState v-if="!loading && !items.length" emoji="📜" title="No audit entries yet" />
    <div v-if="loading" class="spinner" />
    <button v-else-if="items.length < total" class="btn secondary block" @click="load(true)">Load more</button>
  </div>
</template>
