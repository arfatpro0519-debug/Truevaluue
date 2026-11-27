// Alertes Telegram (Phase 5) : règle configurable, anti-spam, commandes /start /alertes /stop.
// Aucun langage de promesse de gain. Les abonnements vivent dans SubscriptionStore via CalibrationStore.

import { parseKickoff } from './enrich.js';

export const ALERT_RULE_DEFAULTS = Object.freeze({
  netMinPp: 4,
  pmMinLiquidityUsd: 5000,
  maxAgeS: 600,
  dailyCap: 10,
});

const STATE_KEY = 'telegram_alerts_state';
const DISCLAIMER = '18+ · Outil d’analyse statistique, aucun gain garanti. Non affilié à Betfair ni Polymarket.';

function dateKey(nowMs) {
  return new Date(nowMs).toISOString().slice(0, 10);
}

function esc(text) {
  return String(text ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

export class TelegramAlerts {
  constructor({ cfg = {}, calibration = null, sendMessage = null } = {}) {
    this.cfg = cfg;
    this.calibration = calibration;
    this.rules = {
      netMinPp: Number.isFinite(cfg.alertNetMinPp) ? cfg.alertNetMinPp : ALERT_RULE_DEFAULTS.netMinPp,
      pmMinLiquidityUsd: Number.isFinite(cfg.alertPmMinLiquidityUsd)
        ? cfg.alertPmMinLiquidityUsd
        : ALERT_RULE_DEFAULTS.pmMinLiquidityUsd,
      maxAgeS: Number.isFinite(cfg.alertMaxAgeS) ? cfg.alertMaxAgeS : ALERT_RULE_DEFAULTS.maxAgeS,
      dailyCap: Number.isFinite(cfg.alertDailyCap) ? cfg.alertDailyCap : ALERT_RULE_DEFAULTS.dailyCap,
    };
    this.sendMessage = typeof sendMessage === 'function' ? sendMessage : null;
  }

  _state() {
    try {
      const raw = this.calibration?.getSetting?.(STATE_KEY);
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (parsed && typeof parsed === 'object') {
        return { subs: parsed.subs || {}, sent: parsed.sent || {}, daily: parsed.daily || {} };
      }
    } catch {
      // État absent = état vide, jamais une valeur inventée.
    }
    return { subs: {}, sent: {}, daily: {} };
  }

  _save(state) {
    return Boolean(this.calibration?.setSetting?.(STATE_KEY, JSON.stringify(state)));
  }

  getSubscription(userId) {
    const id = String(userId || '');
    return this._state().subs[id] || null;
  }

  subscribe(userId, chatId = null, rules = {}) {
    const id = String(userId || '');
    if (!id) return null;
    const state = this._state();
    state.subs[id] = {
      actif: true,
      chat_id: chatId === null ? (state.subs[id]?.chat_id ?? null) : String(chatId),
      created_at: state.subs[id]?.created_at || new Date().toISOString(),
      rules: { ...this.rules, ...rules },
      updated_at: new Date().toISOString(),
    };
    this._save(state);
    return state.subs[id];
  }

  unsubscribe(userId) {
    const id = String(userId || '');
    const state = this._state();
    const existed = Boolean(state.subs[id]?.actif);
    delete state.subs[id];
    this._save(state);
    return existed;
  }

  listActive() {
    return Object.entries(this._state().subs)
      .filter(([, s]) => s?.actif)
      .map(([userId, s]) => ({ telegram_user_id: userId, ...s }));
  }

  // 5.1 règle de déclenchement : réutilise la valeur nette déjà calculée côté moteur.
  isEligible(card, sourcesStatus = null, nowMs = Date.now()) {
    if (!card || card.type !== 'net') return false;
    const net = card.valeur_nette_pts;
    const liq = card.liquidite_polymarket_usd;
    if (!Number.isFinite(net) || !Number.isFinite(liq)) return false;
    if (net < this.rules.netMinPp || liq < this.rules.pmMinLiquidityUsd) return false;
    const kickoff = parseKickoff(card.match?.kickoff);
    if (kickoff && kickoff.getTime() <= nowMs) return false;
    const ages = [
      card.fraicheur?.betfair_age_s ?? null,
      card.fraicheur?.polymarket_age_s ?? null,
    ].filter((v) => v !== null);
    if (ages.length < 2) return false;
    if (ages.some((age) => age > this.rules.maxAgeS)) return false;
    if (sourcesStatus) {
      // Seules les sources qui alimentent l'écart doivent être disponibles :
      // ESPN/SportScore servent au règlement des scores, pas aux alertes.
      const down = (sourcesStatus.sources || []).some(
        (s) => ['betfair', 'polymarket'].includes(s.nom) && s.etat === 'panne'
      );
      if (down) return false;
    }
    return true;
  }

  // 5.2 anti-spam : un message par couple match+issue et par jour, plafond par utilisateur.
  async evaluateAndSend({ ecarts = [], sourcesStatus = null, nowMs = Date.now() } = {}) {
    const state = this._state();
    const day = dateKey(nowMs);
    const sent = state.sent[day] || {};
    const active = this.listActive();
    if (active.length === 0) return { envoyees: 0, raison: 'aucun abonné' };
    let envoyees = 0;

    for (const card of ecarts) {
      if (!this.isEligible(card, sourcesStatus, nowMs)) continue;
      const matchKey = card.fixture_key || [card.match?.home, card.match?.away, card.match?.kickoff].filter(Boolean).join('-');
      const signalKey = `${matchKey}::${card.marche || ''}::${card.issue || ''}`.toLocaleLowerCase('fr');
      for (const sub of active) {
        // Anti-spam PAR ABONNÉ : un destinataire ne doit pas priver les autres
        // de la même alerte.
        const key = `${sub.telegram_user_id}|${signalKey}`;
        if (sent[key]) continue;
        const dailyKey = `${sub.telegram_user_id}|${day}`;
        const count = state.daily[dailyKey] || 0;
        if (count >= (sub.rules?.dailyCap ?? this.rules.dailyCap)) continue;
        const text =
          `<b>Écart net</b> · ${esc(card.match?.home)} – ${esc(card.match?.away)} · ${esc(card.marche)}\n` +
          `${esc(card.issue)} : Betfair ${card.betfair_pct ?? '—'} % · Polymarket ${card.polymarket_pct ?? '—'} %\n` +
          `Valeur nette ${card.valeur_nette_pts} pts · liquidité $${Math.round(card.liquidite_polymarket_usd)}\n` +
          `${DISCLAIMER}`;
        const ok = await this._deliver(sub.chat_id, text);
        if (!ok) continue;
        sent[key] = true;
        state.daily[dailyKey] = count + 1;
        envoyees += 1;
      }
    }
    state.sent[day] = sent;
    this._save(state);
    return { envoyees, compared: ecarts.length };
  }

  async _deliver(chatId, text) {
    if (this.sendMessage) {
      try {
        await this.sendMessage({ chat_id: chatId, text, parse_mode: 'HTML' });
        return true;
      } catch (err) {
        console.error('Envoi Telegram impossible:', err?.message || err);
        return false;
      }
    }
    const token = this.cfg.telegramBotToken;
    if (!token || !chatId) return false;
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
        signal: AbortSignal.timeout(8000),
      });
      return res.ok;
    } catch (err) {
      console.error('Envoi Telegram impossible:', err?.message || err);
      return false;
    }
  }

  // 5.3 commandes du bot. Le webhook est déjà authentifié par secret partagé.
  async handleUpdate(update = {}) {
    const msg = update.message || update.edited_message || {};
    const text = typeof msg.text === 'string' ? msg.text.trim() : '';
    const command = text.split(/\s/)[0]?.split('@')[0]?.toLocaleLowerCase('fr');
    if (!['/start', '/alertes', '/stop'].includes(command)) return { handled: false };
    const user = msg.from || {};
    const userId = String(user.id || '');
    if (!userId) return { handled: true, command, error: 'utilisateur inconnu' };
    const chatId = msg.chat?.id ?? userId;

    if (command === '/start') {
      await this._deliver(chatId, `Truevalue · ${DISCLAIMER}\nUtilise /alertes pour activer les alertes, /stop pour les couper.`);
      return { handled: true, command };
    }
    if (command === '/alertes') {
      this.subscribe(userId, chatId);
      const r = this.getSubscription(userId)?.rules || this.rules;
      await this._deliver(
        chatId,
        `Alertes activées : valeur nette ≥ ${r.netMinPp} pts, liquidité Polymarket ≥ $${r.pmMinLiquidityUsd}, données fraîches et avant coup d’envoi. Plafond ${r.dailyCap}/jour. ${DISCLAIMER}`
      );
      return { handled: true, command };
    }
    this.unsubscribe(userId);
    await this._deliver(chatId, `Alertes désactivées immédiatement. ${DISCLAIMER}`);
    return { handled: true, command };
  }
}
