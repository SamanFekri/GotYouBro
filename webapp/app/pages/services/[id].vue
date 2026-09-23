<script setup lang="ts">
import { useAuthStore } from '~/stores/auth';
import type { Destination, HealthEvent, Service } from '~/utils/types';

const route = useRoute();
const api = useApi();
const toast = useToast();
const auth = useAuthStore();
const { confirm } = useTelegram();
const id = computed(() => String(route.params.id));

const { data: service, loading, error, reload } = useLoader(() => api.get<Service & { healthEvents: HealthEvent[] }>(`/app/services/${id.value}`));
const destinations = ref<Destination[]>([]);
onMounted(async () => (destinations.value = await api.get<Destination[]>('/app/destinations')));

const form = reactive({
  name: '',
  description: '',
  destinationId: '',
  apiEnabled: true,
  healthEnabled: false,
  healthNotify: true,
  healthIntervalSeconds: 60,
  healthGraceSeconds: 60,
});
watch(service, (s) => {
  if (!s) return;
  Object.assign(form, {
    name: s.name,
    description: s.description ?? '',
    destinationId: s.destinationId ?? '',
    apiEnabled: s.apiEnabled,
    healthEnabled: s.healthEnabled,
    healthNotify: s.healthNotify,
    healthIntervalSeconds: s.healthIntervalSeconds,
    healthGraceSeconds: s.healthGraceSeconds,
  });
});

const saving = ref(false);
async function save() {
  saving.value = true;
  try {
    await api.patch(`/app/services/${id.value}`, {
      name: form.name,
      description: form.description || null,
      destinationId: form.destinationId || null,
      apiEnabled: form.apiEnabled,
      healthEnabled: form.healthEnabled,
      healthNotify: form.healthNotify,
      healthIntervalSeconds: Number(form.healthIntervalSeconds),
      healthGraceSeconds: Number(form.healthGraceSeconds),
    });
    toast.success('Saved');
    await reload();
  } catch (err) {
    toast.error((err as Error).message);
  } finally {
    saving.value = false;
  }
}

async function toggleEnabled() {
  if (!service.value) return;
  const next = service.value.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE';
  try {
    await api.patch(`/app/services/${id.value}`, { status: next });
    toast.success(next === 'ACTIVE' ? 'Service enabled' : 'Service disabled');
    await reload();
  } catch (err) {
    toast.error((err as Error).message);
  }
}

const newToken = ref<string | null>(null);
async function generateToken() {
  if (service.value?.token && !(await confirm('Rotate the token? The current token stops working immediately.'))) return;
  try {
    const res = await api.post<{ token: string }>(`/app/services/${id.value}/token`);
    newToken.value = res.token;
    await reload();
  } catch (err) {
    toast.error((err as Error).message);
  }
}

async function revokeToken() {
  if (!(await confirm('Revoke the token? API calls with it will be rejected.'))) return;
  try {
    await api.del(`/app/services/${id.value}/token`);
    toast.success('Token revoked');
    await reload();
  } catch (err) {
    toast.error((err as Error).message);
  }
}

async function remove() {
  if (!(await confirm(`Delete “${service.value?.name}” and its backup history? This cannot be undone.`))) return;
  try {
    await api.del(`/app/services/${id.value}`);
    toast.success('Service deleted');
    auth.refreshMe();
    navigateTo('/services');
  } catch (err) {
    toast.error((err as Error).message);
  }
}

const healthLabel = computed(() => (service.value?.healthEnabled ? service.value.healthStatus : 'OFF'));
</script>

<template>
  <div class="page">
    <div class="page-header">
      <NuxtLink to="/services" class="btn ghost">‹ Services</NuxtLink>
    </div>

    <div v-if="loading && !service" class="spinner" />
    <div v-else-if="error" class="alert">{{ error }}</div>
    <template v-else-if="service">
      <div class="spread">
        <h1>{{ service.name }}</h1>
        <StatusBadge :status="service.status" />
      </div>
      <div v-if="service.status === 'SUSPENDED'" class="alert">This service was suspended by an administrator. API requests are rejected.</div>

      <div class="card">
        <dl class="kv">
          <dt>Current health</dt>
          <dd><StatusBadge :status="healthLabel" /></dd>
          <dt>Last heartbeat</dt>
          <dd>{{ timeAgo(service.lastHeartbeatAt) }}</dd>
          <dt>Last backup</dt>
          <dd>{{ timeAgo(service.lastBackupAt) }}</dd>
          <dt>Backup count</dt>
          <dd>{{ service.backupCount }}</dd>
          <dt>Outages</dt>
          <dd>{{ service.downCount }} · {{ formatDuration(service.totalDowntimeSeconds) }} total</dd>
          <dt>Destination</dt>
          <dd>{{ service.destination?.name ?? 'None' }}</dd>
        </dl>
      </div>

      <div class="section-label">API token</div>
      <div class="card form">
        <div v-if="service.token" class="spread">
          <div>
            <div class="mono">{{ service.token.prefix }}…</div>
            <div class="hint">Created {{ formatDate(service.token.createdAt) }} · used {{ timeAgo(service.token.lastUsedAt) }}</div>
          </div>
          <span class="badge ok"><span class="dot" />Active</span>
        </div>
        <div v-else class="hint">No active token. Generate one to use the API.</div>
        <div class="row">
          <button class="btn small" @click="generateToken">{{ service.token ? 'Rotate token' : 'Generate token' }}</button>
          <button v-if="service.token" class="btn small danger" @click="revokeToken">Revoke</button>
        </div>
      </div>

      <div class="section-label">Settings</div>
      <form class="card form" @submit.prevent="save">
        <label class="field"><span>Name</span><input v-model="form.name" class="input" required maxlength="80" /></label>
        <label class="field"><span>Description</span><textarea v-model="form.description" class="input" maxlength="500" /></label>
        <label class="field">
          <span>Backup destination</span>
          <select v-model="form.destinationId" class="input">
            <option value="">None</option>
            <option v-for="d in destinations" :key="d.id" :value="d.id" :disabled="!d.verified">
              {{ d.name }} · {{ destinationTypeLabel[d.type] }}{{ d.verified ? '' : ' (unverified)' }}
            </option>
          </select>
        </label>
        <label class="switch">API access <input v-model="form.apiEnabled" type="checkbox" /></label>

        <div class="section-label" style="padding: 4px 0 0">Health monitoring</div>
        <label class="switch">Monitor heartbeats <input v-model="form.healthEnabled" type="checkbox" /></label>
        <template v-if="form.healthEnabled">
          <label class="switch">Telegram alerts <input v-model="form.healthNotify" type="checkbox" /></label>
          <div class="row" style="flex-wrap: nowrap">
            <label class="field" style="flex: 1"><span>Heartbeat interval (s)</span><input v-model.number="form.healthIntervalSeconds" class="input" type="number" min="10" /></label>
            <label class="field" style="flex: 1"><span>Grace period (s)</span><input v-model.number="form.healthGraceSeconds" class="input" type="number" min="0" /></label>
          </div>
          <div class="hint">Marked down if no heartbeat for {{ form.healthIntervalSeconds + form.healthGraceSeconds }}s.</div>
        </template>
        <button class="btn block" :disabled="saving">{{ saving ? 'Saving…' : 'Save changes' }}</button>
      </form>

      <template v-if="service.healthEvents.length">
        <div class="section-label">Outage history</div>
        <div class="list">
          <div v-for="e in service.healthEvents" :key="e.id" class="list-item">
            <div class="grow">
              <div class="title">{{ formatDate(e.startedAt) }}</div>
              <div class="sub">{{ e.endedAt ? `Lasted ${formatDuration(e.durationSeconds)}` : 'Ongoing' }}</div>
            </div>
            <StatusBadge :status="e.endedAt ? 'HEALTHY' : 'DOWN'" />
          </div>
        </div>
      </template>

      <div class="section-label">Danger zone</div>
      <div class="card row">
        <button v-if="service.status !== 'SUSPENDED'" class="btn secondary" @click="toggleEnabled">
          {{ service.status === 'ACTIVE' ? 'Disable service' : 'Enable service' }}
        </button>
        <button class="btn danger" @click="remove">Delete service</button>
      </div>
    </template>

    <TokenReveal :token="newToken" :service-name="service?.name" @close="newToken = null" />
  </div>
</template>
