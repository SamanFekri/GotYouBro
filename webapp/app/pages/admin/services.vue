<script setup lang="ts">
import type { Page, Service, ServiceStatus } from '~/utils/types';

definePageMeta({ middleware: 'admin' });

type AdminService = Service & { owner: { id: string; telegramId: number; username: string | null; blocked: boolean } };

const api = useApi();
const toast = useToast();
const q = ref('');
const status = ref<ServiceStatus | ''>('');
const items = ref<AdminService[]>([]);
const total = ref(0);
const loading = ref(false);
const editing = ref<AdminService | null>(null);
const overrides = reactive({ maxBackupSizeMb: '', apiRateLimit: '', backupRateLimit: '', heartbeatRateLimit: '' });

async function load(append = false) {
  loading.value = true;
  try {
    const page = await api.get<Page<AdminService>>('/admin/services', { q: q.value, status: status.value, limit: 50, offset: append ? items.value.length : 0 });
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
watch(status, () => load());

async function setStatus(s: AdminService, next: 'ACTIVE' | 'SUSPENDED') {
  try {
    await api.patch(`/admin/services/${s.id}/status`, { status: next });
    toast.success(next === 'SUSPENDED' ? 'Suspended' : 'Enabled');
    load();
  } catch (err) {
    toast.error((err as Error).message);
  }
}

function edit(s: AdminService) {
  editing.value = s;
  overrides.maxBackupSizeMb = s.maxBackupSizeMb?.toString() ?? '';
  overrides.apiRateLimit = s.apiRateLimit ?? '';
  overrides.backupRateLimit = s.backupRateLimit ?? '';
  overrides.heartbeatRateLimit = s.heartbeatRateLimit ?? '';
}

async function saveOverrides() {
  const str = (v: string) => (v.trim() ? v.trim() : null);
  try {
    await api.patch(`/admin/services/${editing.value!.id}/limits`, {
      maxBackupSizeMb: overrides.maxBackupSizeMb ? Number(overrides.maxBackupSizeMb) : null,
      apiRateLimit: str(overrides.apiRateLimit),
      backupRateLimit: str(overrides.backupRateLimit),
      heartbeatRateLimit: str(overrides.heartbeatRateLimit),
    });
    toast.success('Service limits saved');
    editing.value = null;
    load();
  } catch (err) {
    toast.error((err as Error).message);
  }
}
</script>

<template>
  <div class="page">
    <div class="page-header"><NuxtLink to="/admin" class="btn ghost">‹ Admin</NuxtLink></div>
    <div class="spread"><h1>Services</h1><span class="hint">{{ total }}</span></div>
    <input v-model="q" class="input" placeholder="Search by name, id or owner" />
    <div class="chips">
      <button v-for="s in ['', 'ACTIVE', 'DISABLED', 'SUSPENDED'] as const" :key="s" class="chip" :class="{ active: status === s }" @click="status = s">{{ s || 'All' }}</button>
    </div>

    <div class="list">
      <div v-for="s in items" :key="s.id" class="list-item">
        <div class="grow">
          <div class="title">{{ s.name }}</div>
          <div class="sub">
            <NuxtLink :to="`/admin/users/${s.owner.id}`">{{ s.owner.username ? '@' + s.owner.username : s.owner.telegramId }}</NuxtLink>
            · {{ s.backupCount }} backups · {{ s.healthEnabled ? s.healthStatus.toLowerCase() : 'not monitored' }}
          </div>
        </div>
        <StatusBadge :status="s.status" />
        <button class="btn ghost" aria-label="Limits" @click="edit(s)">⚙️</button>
        <button v-if="s.status === 'SUSPENDED'" class="btn small secondary" @click="setStatus(s, 'ACTIVE')">Enable</button>
        <button v-else class="btn small danger" @click="setStatus(s, 'SUSPENDED')">Suspend</button>
      </div>
    </div>
    <div v-if="loading" class="spinner" />
    <button v-else-if="items.length < total" class="btn secondary block" @click="load(true)">Load more</button>

    <AppModal :open="!!editing" :title="`Limits · ${editing?.name}`" @close="editing = null">
      <form class="form" @submit.prevent="saveOverrides">
        <div class="hint">Empty = use the user/global limit. Per-service API/backup limits apply in addition to the owner's shared limits.</div>
        <label class="field"><span>Max backup MB</span><input v-model="overrides.maxBackupSizeMb" class="input" type="number" min="1" /></label>
        <label class="field"><span>API rate limit</span><input v-model="overrides.apiRateLimit" class="input mono" placeholder="e.g. 20/minute" /></label>
        <label class="field"><span>Backup rate limit</span><input v-model="overrides.backupRateLimit" class="input mono" placeholder="e.g. 5/hour" /></label>
        <label class="field"><span>Heartbeat rate limit</span><input v-model="overrides.heartbeatRateLimit" class="input mono" placeholder="e.g. 4/minute" /></label>
        <button class="btn block">Save</button>
      </form>
    </AppModal>
  </div>
</template>
