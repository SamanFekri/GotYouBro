<script setup lang="ts">
import { useAuthStore } from '~/stores/auth';
const auth = useAuthStore();
</script>

<template>
  <div class="page">
    <div class="page-header"><h1>More</h1></div>
    <div class="list">
      <NuxtLink to="/destinations" class="list-item"><span class="list-icon"><AppIcon name="destination" :size="18" /></span><div class="grow title">Destinations</div><AppIcon name="chevron" :size="18" class="chevron" /></NuxtLink>
      <NuxtLink to="/keys" class="list-item"><span class="list-icon"><AppIcon name="key" :size="18" /></span><div class="grow title">API keys</div><AppIcon name="chevron" :size="18" class="chevron" /></NuxtLink>
      <NuxtLink to="/settings" class="list-item"><span class="list-icon"><AppIcon name="settings" :size="18" /></span><div class="grow title">Settings</div><AppIcon name="chevron" :size="18" class="chevron" /></NuxtLink>
      <a href="/api/docs" target="_blank" class="list-item"><span class="list-icon"><AppIcon name="docs" :size="18" /></span><div class="grow title">API documentation</div><AppIcon name="external" :size="16" class="chevron" /></a>
    </div>
    <template v-if="auth.isAdmin">
      <div class="section-label">Administration</div>
      <div class="list">
        <NuxtLink to="/admin" class="list-item"><span class="list-icon"><AppIcon name="admin" :size="18" /></span><div class="grow title">Admin panel</div><AppIcon name="chevron" :size="18" class="chevron" /></NuxtLink>
      </div>
    </template>
  </div>
</template>
