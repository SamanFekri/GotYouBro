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
});
watch(service, (s) => {
  if (!s) return;
  Object.assign(form, {
    name: s.name,
    description: s.description ?? '',
    destinationId: s.destinationId ?? '',
    apiEnabled: s.apiEnabled,
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

// ---- Monitors
const addingMonitor = ref(false);
const monitorForm = reactive({ name: '', key: '', intervalSeconds: 60, graceSeconds: 60 });
const savingMonitor = ref(false);
async function addMonitor() {
  savingMonitor.value = true;
  try {
    await api.post(`/app/services/${id.value}/monitors`, {
      name: monitorForm.name,
      ...(monitorForm.key ? { key: monitorForm.key.trim().toLowerCase() } : {}),
      intervalSeconds: Number(monitorForm.intervalSeconds),
      graceSeconds: Number(monitorForm.graceSeconds),
    });
    toast.success('Monitor added');
    addingMonitor.value = false;
    Object.assign(monitorForm, { name: '', key: '' });
    await reload();
  } catch (err) {
    toast.error((err as Error).message);
  } finally {
    savingMonitor.value = false;
  }
}
const monitorLimit = computed(() => auth.user?.limits.maxMonitorsPerService ?? null);
const atMonitorLimit = computed(() => monitorLimit.value !== null && (service.value?.monitors.length ?? 0) >= monitorLimit.value);
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

      <div class="spread section-label">
        <span>Health monitors ({{ service.monitors.length }})</span>
        <button class="btn small secondary" :disabled="atMonitorLimit" @click="addingMonitor = true">+ Add monitor</button>
      </div>
      <EmptyState
        v-if="!service.monitors.length"
        emoji="💓"
        title="No monitors yet"
        text="Add a monitor for each part of this service you want to watch (API, worker, cron job…). Each gets its own heartbeat URL."
      />
      <MonitorCard v-for="m in service.monitors" :key="m.id" :monitor="m" editable @changed="reload" />

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

        <button class="btn block" :disabled="saving">{{ saving ? 'Saving…' : 'Save changes' }}</button>
      </form>

      <template v-if="service.healthEvents.length">
        <div class="section-label">Outage history</div>
        <div class="list">
          <div v-for="e in service.healthEvents" :key="e.id" class="list-item">
            <div class="grow">
              <div class="title">{{ e.monitorName }} · {{ formatDate(e.startedAt) }}</div>
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

    <AppModal :open="addingMonitor" title="Add monitor" @close="addingMonitor = false">
      <form class="form" @submit.prevent="addMonitor">
        <label class="field"><span>Name</span><input v-model="monitorForm.name" class="input" required maxlength="80" placeholder="Queue worker" /></label>
        <label class="field">
          <span>Key (used in the heartbeat URL, optional)</span>
          <input v-model="monitorForm.key" class="input mono" maxlength="40" pattern="[a-z0-9][a-z0-9_-]*" placeholder="queue-worker" />
        </label>
        <div class="row" style="flex-wrap: nowrap">
          <label class="field" style="flex: 1"><span>Interval (s)</span><input v-model.number="monitorForm.intervalSeconds" class="input" type="number" min="10" /></label>
          <label class="field" style="flex: 1"><span>Grace (s)</span><input v-model.number="monitorForm.graceSeconds" class="input" type="number" min="0" /></label>
        </div>
        <div class="hint">Marked down if no heartbeat arrives for {{ formatDuration(monitorForm.intervalSeconds + monitorForm.graceSeconds) }}.</div>
        <button class="btn block" :disabled="savingMonitor || !monitorForm.name">{{ savingMonitor ? 'Adding…' : 'Add monitor' }}</button>
      </form>
    </AppModal>

    <TokenReveal :token="newToken" :service-name="service?.name" @close="newToken = null" />
  </div>
</template>
