let timer = null;

export function toast(message) {
  const el = document.getElementById('ts');
  if (!el) return;
  el.textContent = String(message || '');
  el.style.opacity = '1';
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    el.style.opacity = '0';
  }, 2200);
}
