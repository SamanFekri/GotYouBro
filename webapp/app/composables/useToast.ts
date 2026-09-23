export interface Toast {
  id: number;
  text: string;
  kind: 'ok' | 'error';
}

let seq = 0;

export function useToast() {
  const toasts = useState<Toast[]>('toasts', () => []);
  const { haptic } = useTelegram();
  function show(text: string, kind: Toast['kind'] = 'ok') {
    const id = ++seq;
    toasts.value.push({ id, text, kind });
    haptic(kind === 'ok' ? 'success' : 'error');
    setTimeout(() => (toasts.value = toasts.value.filter((t) => t.id !== id)), 3500);
  }
  return { toasts, success: (t: string) => show(t, 'ok'), error: (t: string) => show(t, 'error') };
}
