interface TelegramWebApp {
  initData: string;
  colorScheme: 'light' | 'dark';
  ready(): void;
  expand(): void;
  showConfirm(message: string, callback: (ok: boolean) => void): void;
  showAlert(message: string, callback?: () => void): void;
  openTelegramLink(url: string): void;
  HapticFeedback?: { notificationOccurred(type: 'error' | 'success' | 'warning'): void; impactOccurred(style: 'light' | 'medium'): void };
  BackButton: { show(): void; hide(): void; onClick(cb: () => void): void; offClick(cb: () => void): void };
  isVersionAtLeast(version: string): boolean;
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

/** Thin, SSR-safe wrapper around window.Telegram.WebApp with browser fallbacks. */
export function useTelegram() {
  const webApp = import.meta.client ? window.Telegram?.WebApp : undefined;
  const inTelegram = !!webApp?.initData;

  function confirm(message: string): Promise<boolean> {
    if (inTelegram && webApp?.isVersionAtLeast('6.2')) {
      return new Promise((resolve) => webApp.showConfirm(message, resolve));
    }
    return Promise.resolve(window.confirm(message));
  }

  function haptic(type: 'error' | 'success' | 'warning') {
    webApp?.HapticFeedback?.notificationOccurred(type);
  }

  return { webApp, inTelegram, initData: webApp?.initData ?? '', confirm, haptic };
}
