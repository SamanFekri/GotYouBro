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

interface SelfBackupStatus {
  enabled: boolean;
  intervalHours: number;
  intervals: number[];
  recipientTelegramId: number | null;
  recipientName: string | null;
  lastRunAt: string | null;
  lastStatus: 'SUCCESS' | 'FAILED' | null;
  lastError: string | null;
  lastSizeBytes: number | null;
  lastParts: number | null;
  nextRunAt: string | null;
  running: boolean;
}

const intervalLabel = (h: number) => (h === 168 ? 'Every 7 days' : h === 24 ? 'Every day' : h === 1 ? 'Every hour' : `Every ${h} hours`);
const selfBackup = ref<SelfBackupStatus>();
const selfForm = reactive({ enabled: false, intervalHours: 24 });
const selfBusy = ref(false);
function applySelfBackup(s: SelfBackupStatus) {
  selfBackup.value = s;
  selfForm.enabled = s.enabled;
  selfForm.intervalHours = s.intervalHours;
}
onMounted(async () => applySelfBackup(await api.get<SelfBackupStatus>('/admin/self-backup')));

async function saveSelfBackup() {
  try {
    applySelfBackup(await api.put<SelfBackupStatus>('/admin/self-backup', { ...selfForm }));
    toast.success(selfForm.enabled ? 'Database backups scheduled' : 'Database backup schedule saved (off)');
  } catch (err) {
    toast.error((err as Error).message);
  }
}

async function runSelfBackup() {
  selfBusy.value = true;
  try {
    applySelfBackup(await api.post<SelfBackupStatus>('/admin/self-backup/run'));
    toast.success('Database backup sent to your Telegram chat');
  } catch (err) {
    toast.error((err as Error).message);
    applySelfBackup(await api.get<SelfBackupStatus>('/admin/self-backup'));
  } finally {
    selfBusy.value = false;
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

    <div class="section-label">GotYouBro database backup</div>
    <form class="card form" @submit.prevent="saveSelfBackup">
      <div class="hint">
        GotYouBro sends a gzipped snapshot of its own database to your private chat with the bot. Nothing is kept on the server.
        The snapshot contains <b>all</b> users, services and settings, so keep that chat private.
      </div>
      <label class="switch">Send automatically <input v-model="selfForm.enabled" type="checkbox" /></label>
      <label class="field">
        <span>Schedule</span>
        <select v-model.number="selfForm.intervalHours" class="input">
          <option v-for="h in selfBackup?.intervals ?? [1, 6, 12, 24, 168]" :key="h" :value="h">{{ intervalLabel(h) }}</option>
        </select>
      </label>
      <div v-if="selfBackup" class="hint">
        <div v-if="selfBackup.recipientName">Recipient: {{ selfBackup.recipientName }} <span class="muted">(whoever saves this form)</span></div>
        <div v-if="selfBackup.nextRunAt">Next: {{ formatDate(selfBackup.nextRunAt) }}</div>
        <div v-if="selfBackup.lastRunAt">
          Last: {{ timeAgo(selfBackup.lastRunAt) }} ·
          <span class="badge" :class="selfBackup.lastStatus === 'SUCCESS' ? 'ok' : 'bad'">{{ selfBackup.lastStatus === 'SUCCESS' ? 'sent' : 'failed' }}</span>
          <template v-if="selfBackup.lastStatus === 'SUCCESS' && selfBackup.lastSizeBytes !== null">
            · {{ formatBytes(selfBackup.lastSizeBytes) }}<template v-if="(selfBackup.lastParts ?? 1) > 1"> in {{ selfBackup.lastParts }} parts</template>
          </template>
        </div>
        <div v-if="selfBackup.lastStatus === 'FAILED' && selfBackup.lastError" class="alert">{{ selfBackup.lastError }}</div>
      </div>
      <div class="row">
        <button class="btn">Save schedule</button>
        <button type="button" class="btn secondary" :disabled="selfBusy || !selfBackup?.recipientTelegramId" @click="runSelfBackup">
          {{ selfBusy ? 'Sending…' : 'Back up now' }}
        </button>
      </div>
      <div v-if="!selfBackup?.recipientTelegramId" class="hint">Save the schedule once before using “Back up now”. Make sure you have started a chat with the bot.</div>
    </form>

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
