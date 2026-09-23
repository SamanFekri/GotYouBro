<script setup lang="ts">
import { useAuthStore } from '~/stores/auth';
const auth = useAuthStore();
</script>

<template>
  <div class="page">
    <div class="page-header"><h1>More</h1></div>
    <div class="list">
      <NuxtLink to="/destinations" class="list-item"><span>📬</span><div class="grow title">Destinations</div><span class="muted">›</span></NuxtLink>
      <NuxtLink to="/keys" class="list-item"><span>🔑</span><div class="grow title">API keys</div><span class="muted">›</span></NuxtLink>
      <NuxtLink to="/settings" class="list-item"><span>⚙️</span><div class="grow title">Settings</div><span class="muted">›</span></NuxtLink>
      <a href="/api/docs" target="_blank" class="list-item"><span>📖</span><div class="grow title">API documentation</div><span class="muted">↗</span></a>
    </div>
    <template v-if="auth.isAdmin">
      <div class="section-label">Administration</div>
      <div class="list">
        <NuxtLink to="/admin" class="list-item"><span>🛡</span><div class="grow title">Admin panel</div><span class="muted">›</span></NuxtLink>
      </div>
    </template>
  </div>
</template>
