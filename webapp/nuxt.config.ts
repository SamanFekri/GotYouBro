// Single-page Telegram Web App. Generated as static files and served by the API server.
export default defineNuxtConfig({
  compatibilityDate: '2026-01-01',
  ssr: false,
  devtools: { enabled: false },
  modules: ['@pinia/nuxt'],
  css: ['~/assets/css/main.css'],
  app: {
    head: {
      title: 'GotYouBro',
      htmlAttrs: { lang: 'en' },
      meta: [
        { name: 'viewport', content: 'width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover' },
        { name: 'color-scheme', content: 'light dark' },
      ],
      link: [
        { rel: 'icon', href: '/favicon.png', type: 'image/png' },
        { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' },
      ],
      // Must load before the app so window.Telegram.WebApp is available on start.
      script: [{ src: 'https://telegram.org/js/telegram-web-app.js', tagPosition: 'head' }],
    },
  },
  typescript: { strict: true },
  nitro: {
    // `npm run dev:webapp` proxies API calls to the backend on :6969.
    devProxy: { '/api': { target: 'http://localhost:6969/api', changeOrigin: true } },
  },
});
