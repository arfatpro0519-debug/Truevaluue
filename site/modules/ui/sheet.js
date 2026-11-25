export function initSheet() {
  document.addEventListener('click', (e) => {
    if (e.target?.id === 'ov') closeSheet();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeSheet();
  });
}

export function openSheet(html) {
  const sheet = document.getElementById('sh');
  if (!sheet) return;
  sheet.innerHTML = html;
  document.body.classList.add('o');
  sheet.focus?.();
}

export function closeSheet() {
  document.body.classList.remove('o');
}

export function isSheetOpen() {
  return document.body.classList.contains('o');
}
