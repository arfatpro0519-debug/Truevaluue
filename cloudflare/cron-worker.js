// Cron Cloudflare gratuit : appelle le service Render toutes les 10 minutes.
// Secrets : CRON_SECRET et RENDER_BASE_URL (wrangler secret put ...).
// Aucun secret n'est écrit dans ce fichier.

export default {
  async scheduled(_event, env, ctx) {
    const base = String(env.RENDER_BASE_URL || '').replace(/\/$/, '');
    if (!base) {
      console.error('RENDER_BASE_URL manquant');
      return;
    }
    const task = (async () => {
      const res = await fetch(`${base}/api/cron/sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Cron-Secret': String(env.CRON_SECRET || ''),
        },
        body: '{}',
      });
      if (!res.ok) {
        console.error(`Cron Render HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }
      return res.status;
    })();
    ctx.waitUntil(task);
  },

  async fetch() {
    return new Response('Truevalue cron worker — OK\n18+ · outil d’analyse, aucun gain garanti.', {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  },
};
