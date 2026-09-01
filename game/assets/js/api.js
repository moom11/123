/*
 * api.js — الاتصال بلوحة الأبطال (PHP + MySQL على الاستضافة).
 * إذا لم يعمل الخادم (أو شغّلت اللعبة كملف محلي) ترجع اللعبة تلقائياً
 * إلى لوحة أبطال محلية مخزّنة في المتصفح، فلا تتعطل أبداً.
 */
window.API = (function () {
  'use strict';

  const BASE = 'api/';
  const LS_LOCAL_BOARD = 'nayzak.localboard';
  let online = true;      // يُطفأ تلقائياً عند أول فشل
  let ticket = null;      // تذكرة الجولة الحالية من الخادم

  function req(path, opts) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    return fetch(BASE + path, Object.assign({ signal: ctrl.signal, cache: 'no-store' }, opts))
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
      .finally(() => clearTimeout(t));
  }

  /* ---------- لوحة احتياطية داخل المتصفح ---------- */
  function localBoard() {
    try { return JSON.parse(localStorage.getItem(LS_LOCAL_BOARD)) || []; }
    catch (e) { return []; }
  }
  function localSave(name, score) {
    const rows = localBoard();
    rows.push({ name: name, score: score, local: true });
    rows.sort((a, b) => b.score - a.score);
    const top = rows.slice(0, 20);
    try { localStorage.setItem(LS_LOCAL_BOARD, JSON.stringify(top)); } catch (e) {}
    return top;
  }

  return {
    get isOnline() { return online; },

    /** تُطلب عند بداية كل جولة — تمنع إرسال نتائج مزيفة. */
    startRound() {
      ticket = null;
      if (!online) return Promise.resolve(null);
      return req('session.php')
        .then((d) => { ticket = d && d.ok ? d : null; return ticket; })
        .catch(() => { online = false; return null; });
    },

    /** إرسال النتيجة. تُرجع { ok, rank?, offline? } ولا ترمي استثناءً. */
    submit(name, score, coins) {
      name = String(name || 'لاعب').slice(0, 20);
      if (!online || !ticket) {
        localSave(name, score);
        return Promise.resolve({ ok: true, offline: true });
      }
      const body = new URLSearchParams({
        sid: ticket.sid, ts: String(ticket.ts), sig: ticket.sig,
        name: name, score: String(score), coins: String(coins)
      });
      return req('submit.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: body
      })
        .then((d) => { ticket = null; return d; })
        .catch(() => { localSave(name, score); return { ok: true, offline: true }; });
    },

    /** أفضل 20 نتيجة. */
    top() {
      if (!online) return Promise.resolve({ ok: true, rows: localBoard(), offline: true });
      return req('top.php')
        .then((d) => (d && d.ok ? d : { ok: true, rows: localBoard(), offline: true }))
        .catch(() => { online = false; return { ok: true, rows: localBoard(), offline: true }; });
    }
  };
})();
