let onClose = null;

export function initSheet() {
  document.addEventListener('click', (e) => {
    if (e.target?.id === 'ov') closeSheet();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeSheet();
  });
}

export function openSheet(html, afterRender = null) {
  const sheet = document.getElementById('sh');
  if (!sheet) return;
  sheet.innerHTML = html;
  document.body.classList.add('o');
  sheet.focus?.();
  onClose = afterRender;
}

export function closeSheet() {
  document.body.classList.remove('o');
  onClose = null;
}

export function isSheetOpen() {
  return document.body.classList.contains('o');
}
