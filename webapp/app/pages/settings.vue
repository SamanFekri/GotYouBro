<script setup lang="ts">
import { useAuthStore } from '~/stores/auth';
import type { Me } from '~/utils/types';

const auth = useAuthStore();
const api = useApi();
const toast = useToast();

async function update(patch: Partial<Pick<Me, 'notifyHealth' | 'notifyBackupFailures'>>) {
  try {
    auth.user = await api.patch<Me>('/app/me/settings', patch);
    toast.success('Saved');
  } catch (err) {
    toast.error((err as Error).message);
  }
}
</script>

<template>
  <div class="page">
    <div class="page-header">
      <NuxtLink to="/more" class="btn ghost">‹ More</NuxtLink>
    </div>
    <h1>Settings</h1>

    <template v-if="auth.user">
      <div class="section-label">Notifications</div>
      <div class="card form">
        <label class="switch">
          <span>Health alerts<br /><span class="hint">Down and recovery messages</span></span>
          <input type="checkbox" :checked="auth.user.notifyHealth" @change="update({ notifyHealth: ($event.target as HTMLInputElement).checked })" />
        </label>
        <label class="switch">
          <span>Backup failure alerts<br /><span class="hint">When a backup can’t be delivered</span></span>
          <input type="checkbox" :checked="auth.user.notifyBackupFailures" @change="update({ notifyBackupFailures: ($event.target as HTMLInputElement).checked })" />
        </label>
      </div>

      <div class="section-label">Your limits</div>
      <div class="card">
        <dl class="kv">
          <dt>Services</dt>
          <dd>{{ auth.user.serviceCount }} / {{ auth.user.limits.maxServices ?? 'Unlimited' }}</dd>
          <dt>Monitors per service</dt>
          <dd>{{ auth.user.limits.maxMonitorsPerService ?? 'Unlimited' }}</dd>
          <dt>Max backup size</dt>
          <dd>{{ formatBytes(auth.user.limits.maxBackupBytes) }}</dd>
          <dt>API requests</dt>
          <dd>{{ auth.user.limits.apiRateLimit }}</dd>
          <dt>Backups</dt>
          <dd>{{ auth.user.limits.backupRateLimit }}</dd>
          <dt>Heartbeats (per monitor)</dt>
          <dd>{{ auth.user.limits.heartbeatRateLimit }}</dd>
        </dl>
        <div class="hint" style="margin-top: 10px">API and backup limits are shared across all your services.</div>
      </div>

      <div class="section-label">Account</div>
      <div class="card">
        <dl class="kv">
          <dt>Telegram</dt>
          <dd>{{ auth.user.username ? `@${auth.user.username}` : auth.user.firstName }}</dd>
          <dt>Telegram ID</dt>
          <dd class="mono">{{ auth.user.telegramId }}</dd>
          <dt>Role</dt>
          <dd>{{ auth.user.isRootAdmin ? 'Root admin' : auth.user.isAdmin ? 'Admin' : 'User' }}</dd>
        </dl>
      </div>
    </template>
  </div>
</template>
