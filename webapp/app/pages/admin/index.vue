<script setup lang="ts">
import type { DefaultLimits } from '~/utils/types';

definePageMeta({ middleware: 'admin' });

interface SystemStats {
  users: { total: number; blocked: number; activeLast24h: number };
  services: { total: number; suspended: number; monitored: number; down: number };
  destinations: number;
  backups: { total: number; last24h: number; failedLast24h: number; bytesLast24h: number };
  outagesLast24h: number;
  queue: { pending: number; running: number };
  uptimeSeconds: number;
}

const api = useApi();
const toast = useToast();
const { data: stats, loading, error } = useLoader(() => api.get<SystemStats>('/admin/stats'));

const limits = reactive<DefaultLimits>({ apiRateLimit: '', backupRateLimit: '', heartbeatRateLimit: '', serviceCreateRateLimit: '', maxBackupSizeMb: 0, maxServicesPerUser: 0, maxMonitorsPerService: 0 });
const envDefaults = ref<DefaultLimits>();
onMounted(async () => {
  const res = await api.get<{ limits: DefaultLimits; envDefaults: DefaultLimits }>('/admin/settings/limits');
  Object.assign(limits, res.limits);
  envDefaults.value = res.envDefaults;
});

async function saveLimits() {
  try {
    const res = await api.put<{ limits: DefaultLimits }>('/admin/settings/limits', { ...limits, maxBackupSizeMb: Number(limits.maxBackupSizeMb), maxServicesPerUser: Number(limits.maxServicesPerUser), maxMonitorsPerService: Number(limits.maxMonitorsPerService) });
    Object.assign(limits, res.limits);
    toast.success('Default limits saved');
  } catch (err) {
    toast.error((err as Error).message);
  }
}

async function resetLimits() {
  const res = await api.del<{ limits: DefaultLimits }>('/admin/settings/limits');
  Object.assign(limits, res.limits);
  toast.success('Reset to environment defaults');
}
</script>

<template>
  <div class="page">
    <div class="page-header">
      <NuxtLink to="/more" class="btn ghost">‹ More</NuxtLink>
    </div>
    <h1>Admin</h1>

    <div class="list">
      <NuxtLink to="/admin/users" class="list-item"><span>👥</span><div class="grow title">Users</div><span class="muted">›</span></NuxtLink>
      <NuxtLink to="/admin/services" class="list-item"><span>🧩</span><div class="grow title">Services</div><span class="muted">›</span></NuxtLink>
      <NuxtLink to="/admin/backups" class="list-item"><span>📦</span><div class="grow title">Backup activity</div><span class="muted">›</span></NuxtLink>
      <NuxtLink to="/admin/audit" class="list-item"><span>📜</span><div class="grow title">Audit log</div><span class="muted">›</span></NuxtLink>
    </div>

    <div v-if="loading" class="spinner" />
    <div v-else-if="error" class="alert">{{ error }}</div>
    <template v-else-if="stats">
      <div class="section-label">System</div>
      <div class="grid">
        <StatCard label="Users" :value="stats.users.total" to="/admin/users" />
        <StatCard label="Active (24h)" :value="stats.users.activeLast24h" />
        <StatCard label="Blocked users" :value="stats.users.blocked" :tone="stats.users.blocked ? 'bad' : 'default'" />
        <StatCard label="Services" :value="stats.services.total" to="/admin/services" />
        <StatCard label="Monitored" :value="stats.services.monitored" />
        <StatCard label="Down now" :value="stats.services.down" :tone="stats.services.down ? 'bad' : 'default'" />
        <StatCard label="Backups (24h)" :value="stats.backups.last24h" to="/admin/backups" />
        <StatCard label="Failed (24h)" :value="stats.backups.failedLast24h" :tone="stats.backups.failedLast24h ? 'bad' : 'default'" />
        <StatCard label="Delivered (24h)" :value="formatBytes(stats.backups.bytesLast24h)" />
        <StatCard label="Outages (24h)" :value="stats.outagesLast24h" />
        <StatCard label="Queue" :value="`${stats.queue.running} / ${stats.queue.pending}`" />
        <StatCard label="Uptime" :value="formatDuration(stats.uptimeSeconds)" />
      </div>
    </template>

    <div class="section-label">Default limits</div>
    <form class="card form" @submit.prevent="saveLimits">
      <div class="hint">Formats: <code>60/minute</code>, <code>30/hour</code>, <code>100/15m</code>, <code>unlimited</code>. API &amp; backup limits apply per user across all services.</div>
      <label class="field"><span>API requests (per user) · env {{ envDefaults?.apiRateLimit }}</span><input v-model="limits.apiRateLimit" class="input mono" /></label>
      <label class="field"><span>Backups (per user) · env {{ envDefaults?.backupRateLimit }}</span><input v-model="limits.backupRateLimit" class="input mono" /></label>
      <label class="field"><span>Heartbeats (per monitor) · env {{ envDefaults?.heartbeatRateLimit }}</span><input v-model="limits.heartbeatRateLimit" class="input mono" /></label>
      <label class="field"><span>Service creation (per user) · env {{ envDefaults?.serviceCreateRateLimit }}</span><input v-model="limits.serviceCreateRateLimit" class="input mono" /></label>
      <div class="row" style="flex-wrap: nowrap">
        <label class="field" style="flex: 1"><span>Max backup MB</span><input v-model.number="limits.maxBackupSizeMb" class="input" type="number" min="1" /></label>
        <label class="field" style="flex: 1"><span>Max services / user</span><input v-model.number="limits.maxServicesPerUser" class="input" type="number" min="0" /></label>
      </div>
      <label class="field"><span>Max monitors / service</span><input v-model.number="limits.maxMonitorsPerService" class="input" type="number" min="1" /></label>
      <div class="hint">Administrators are not limited in services or monitors.</div>
      <div class="row">
        <button class="btn">Save defaults</button>
        <button type="button" class="btn secondary" @click="resetLimits">Reset to env</button>
      </div>
    </form>
  </div>
</template>
