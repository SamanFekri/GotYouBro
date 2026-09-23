<script setup lang="ts">
import { useAuthStore } from '~/stores/auth';
import type { AdminUser, Backup, Destination, Service } from '~/utils/types';

definePageMeta({ middleware: 'admin' });

interface Detail {
  user: AdminUser;
  effectiveLimits: { maxServices: number; maxBackupSizeMb: number; apiRateLimit: string; backupRateLimit: string };
  services: Service[];
  destinations: Destination[];
  recentBackups: Backup[];
}

const route = useRoute();
const api = useApi();
const toast = useToast();
const auth = useAuthStore();
const { confirm } = useTelegram();
const id = String(route.params.id);
const { data, loading, error, reload } = useLoader(() => api.get<Detail>(`/admin/users/${id}`));

const limits = reactive({ maxServices: '', maxBackupSizeMb: '', apiRateLimit: '', backupRateLimit: '' });
watch(data, (d) => {
  if (!d) return;
  limits.maxServices = d.user.maxServices?.toString() ?? '';
  limits.maxBackupSizeMb = d.user.maxBackupSizeMb?.toString() ?? '';
  limits.apiRateLimit = d.user.apiRateLimit ?? '';
  limits.backupRateLimit = d.user.backupRateLimit ?? '';
});

async function act(fn: () => Promise<unknown>, msg: string) {
  try {
    await fn();
    toast.success(msg);
    await reload();
  } catch (err) {
    toast.error((err as Error).message);
  }
}

async function toggleBlock() {
  const u = data.value!.user;
  if (u.blocked) return act(() => api.post(`/admin/users/${id}/unblock`), 'User unblocked');
  if (!(await confirm(`Block ${u.username ? '@' + u.username : u.telegramId}? Their API tokens stop working immediately.`))) return;
  const reason = window.prompt('Reason (optional)') ?? undefined;
  act(() => api.post(`/admin/users/${id}/block`, { reason }), 'User blocked');
}

const numOrNull = (v: string) => (v === '' ? null : Number(v));
const strOrNull = (v: string) => (v.trim() === '' ? null : v.trim());
function saveLimits() {
  act(
    () =>
      api.patch(`/admin/users/${id}/limits`, {
        maxServices: numOrNull(limits.maxServices),
        maxBackupSizeMb: numOrNull(limits.maxBackupSizeMb),
        apiRateLimit: strOrNull(limits.apiRateLimit),
        backupRateLimit: strOrNull(limits.backupRateLimit),
      }),
    'Limits saved',
  );
}

const setRole = (role: 'USER' | 'ADMIN') => act(() => api.patch(`/admin/users/${id}/role`, { role }), 'Role updated');
const setServiceStatus = (s: Service, status: 'ACTIVE' | 'SUSPENDED') =>
  act(() => api.patch(`/admin/services/${s.id}/status`, { status }), status === 'SUSPENDED' ? 'Service suspended' : 'Service enabled');
</script>

<template>
  <div class="page">
    <div class="page-header"><NuxtLink to="/admin/users" class="btn ghost">‹ Users</NuxtLink></div>
    <div v-if="loading && !data" class="spinner" />
    <div v-else-if="error" class="alert">{{ error }}</div>
    <template v-else-if="data">
      <div class="spread">
        <h1>{{ [data.user.firstName, data.user.lastName].filter(Boolean).join(' ') || data.user.telegramId }}</h1>
        <span v-if="data.user.blocked" class="badge bad"><span class="dot" />Blocked</span>
      </div>
      <div class="card">
        <dl class="kv">
          <dt>Username</dt><dd>{{ data.user.username ? '@' + data.user.username : '—' }}</dd>
          <dt>Telegram ID</dt><dd class="mono">{{ data.user.telegramId }}</dd>
          <dt>Role</dt><dd>{{ data.user.isRootAdmin ? 'Root admin' : data.user.role }}</dd>
          <dt>Joined</dt><dd>{{ formatDate(data.user.createdAt) }}</dd>
          <dt>Last seen</dt><dd>{{ timeAgo(data.user.lastSeenAt) }}</dd>
          <template v-if="data.user.blocked"><dt>Block reason</dt><dd>{{ data.user.blockedReason || '—' }}</dd></template>
        </dl>
        <div v-if="!data.user.isRootAdmin" class="row" style="margin-top: 12px">
          <button class="btn small" :class="data.user.blocked ? 'secondary' : 'danger'" @click="toggleBlock">{{ data.user.blocked ? 'Unblock' : 'Block user' }}</button>
          <template v-if="auth.user?.isRootAdmin">
            <button v-if="data.user.role === 'USER'" class="btn small secondary" @click="setRole('ADMIN')">Make admin</button>
            <button v-else class="btn small secondary" @click="setRole('USER')">Remove admin</button>
          </template>
        </div>
      </div>

      <div class="section-label">Limit overrides</div>
      <form class="card form" @submit.prevent="saveLimits">
        <div class="hint">Leave empty to use the default. Effective: {{ data.effectiveLimits.maxServices }} services, {{ data.effectiveLimits.maxBackupSizeMb }} MB, {{ data.effectiveLimits.apiRateLimit }} API, {{ data.effectiveLimits.backupRateLimit }} backups.</div>
        <div class="row" style="flex-wrap: nowrap">
          <label class="field" style="flex: 1"><span>Max services</span><input v-model="limits.maxServices" class="input" type="number" min="0" /></label>
          <label class="field" style="flex: 1"><span>Max backup MB</span><input v-model="limits.maxBackupSizeMb" class="input" type="number" min="1" /></label>
        </div>
        <label class="field"><span>API rate limit</span><input v-model="limits.apiRateLimit" class="input mono" placeholder="default" /></label>
        <label class="field"><span>Backup rate limit</span><input v-model="limits.backupRateLimit" class="input mono" placeholder="default" /></label>
        <button class="btn">Save overrides</button>
      </form>

      <div class="section-label">Services ({{ data.services.length }})</div>
      <div v-if="data.services.length" class="list">
        <div v-for="s in data.services" :key="s.id" class="list-item">
          <div class="grow">
            <div class="title">{{ s.name }}</div>
            <div class="sub">{{ s.backupCount }} backups · {{ s.healthEnabled ? s.healthStatus.toLowerCase() : 'not monitored' }}</div>
          </div>
          <StatusBadge :status="s.status" />
          <button v-if="s.status === 'SUSPENDED'" class="btn small secondary" @click="setServiceStatus(s, 'ACTIVE')">Enable</button>
          <button v-else class="btn small danger" @click="setServiceStatus(s, 'SUSPENDED')">Suspend</button>
        </div>
      </div>
      <div v-else class="hint">No services.</div>

      <div class="section-label">Destinations ({{ data.destinations.length }})</div>
      <div v-if="data.destinations.length" class="list">
        <div v-for="d in data.destinations" :key="d.id" class="list-item">
          <div class="grow"><div class="title">{{ d.name }}</div><div class="sub">{{ destinationTypeLabel[d.type] }} · <span class="mono">{{ d.telegramChatId }}</span></div></div>
          <span class="badge" :class="d.verified ? 'ok' : 'warn'"><span class="dot" />{{ d.verified ? 'Verified' : 'Unverified' }}</span>
        </div>
      </div>

      <div class="section-label">Recent backups</div>
      <div v-if="data.recentBackups.length" class="list">
        <div v-for="b in data.recentBackups" :key="b.id" class="list-item">
          <div class="grow"><div class="title">{{ b.filename }}</div><div class="sub">{{ b.serviceName }} · {{ formatBytes(b.sizeBytes) }} · {{ formatDate(b.createdAt) }}</div></div>
          <StatusBadge :status="b.status" />
        </div>
      </div>
      <div v-else class="hint">No backups.</div>
    </template>
  </div>
</template>
