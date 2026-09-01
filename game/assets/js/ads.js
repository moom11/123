/*
 * ads.js — طبقة الإعلانات (مصدر الربح).
 * ------------------------------------------------------------------
 * كل الإعدادات في الكائن CONFIG بالأسفل. اللعبة تعمل بشكل طبيعي
 * حتى لو تركت كل شيء فارغاً (وضع "بدون إعلانات").
 *
 * الشبكات المدعومة بدون أي تعديل على الكود:
 *   - Monetag / Adsterra  (Rewarded Interstitial عبر دالة show_XXXXXXX)
 *   - أي شبكة تعطيك كود HTML للبانر  -> ضعه في CONFIG.banner.html
 *   - أي شبكة تعطيك Direct Link      -> ضعه في CONFIG.*.directLink
 *
 * راجع ملف README.md لخطوات التسجيل في الشبكات.
 */
window.Ads = (function () {
  'use strict';

  const CONFIG = {
    // ---- بانر ثابت أسفل اللعبة -------------------------------------
    banner: {
      enabled: false,
      // الصق هنا كود البانر الذي تعطيك إياه الشبكة (سكربت أو iframe):
      html: ''
    },

    // ---- إعلان بيني بين الجولات ------------------------------------
    interstitial: {
      enabled: false,
      zoneId: '',          // رقم الزون من Monetag/Adsterra -> يستدعي window['show_'+zoneId]
      directLink: '',      // بديل: رابط Direct Link يُفتح في تبويب جديد
      everyNGames: 3,      // يظهر كل 3 جولات
      minSecondsBetween: 90
    },

    // ---- إعلان مكافأة (إحياء المركبة / عملات) ----------------------
    rewarded: {
      enabled: false,
      zoneId: '',
      directLink: '',
      minSecondsBetween: 45
    },

    maxAdsPerSession: 12
  };

  let gamesPlayed = 0;
  let adsShown = 0;
  let lastAdAt = 0;

  const now = () => Date.now() / 1000;
  const ready = (c) => c && c.enabled && (c.zoneId || c.directLink);

  function budgetLeft(c) {
    if (adsShown >= CONFIG.maxAdsPerSession) return false;
    return now() - lastAdAt >= (c.minSecondsBetween || 0);
  }

  /** يستدعي دالة الشبكة إن وُجدت، وإلا يفتح الـ Direct Link. */
  function run(c) {
    const fn = c.zoneId && window['show_' + c.zoneId];
    if (typeof fn === 'function') {
      // Monetag/Adsterra ترجع Promise يُحل بعد انتهاء مشاهدة الإعلان.
      try {
        return Promise.resolve(fn({ type: 'end' })).then(() => true);
      } catch (e) {
        return Promise.resolve(false);
      }
    }
    if (c.directLink) {
      // يجب أن يُستدعى داخل حدث نقر من المستخدم وإلا حجبه المتصفح.
      const w = window.open(c.directLink, '_blank', 'noopener');
      return Promise.resolve(!!w);
    }
    return Promise.resolve(false);
  }

  function mark() { adsShown++; lastAdAt = now(); }

  const api = {
    /** يُستدعى مرة واحدة عند تحميل الصفحة. */
    init() {
      // فحص تشخيصي: يخبرك في الـ Console إن كان سكربت الشبكة مفقوداً.
      setTimeout(() => {
        [['interstitial', CONFIG.interstitial], ['rewarded', CONFIG.rewarded]].forEach(([k, c]) => {
          if (c.enabled && c.zoneId && typeof window['show_' + c.zoneId] !== 'function' && !c.directLink) {
            console.warn(
              `[Ads] الزون "${c.zoneId}" (${k}) مُفعّل لكن الدالة show_${c.zoneId} غير موجودة.\n` +
              'تأكد أنك لصقت سكربت الشبكة داخل <head> في index.html، وأن مانع الإعلانات مُعطّل.'
            );
          }
        });
      }, 3000);

      const slot = document.getElementById('ad-banner');
      if (slot && CONFIG.banner.enabled && CONFIG.banner.html.trim()) {
        slot.hidden = false;
        // innerHTML لا ينفّذ الوسوم <script>، لذا نعيد إنشاءها يدوياً.
        slot.innerHTML = CONFIG.banner.html;
        slot.querySelectorAll('script').forEach((old) => {
          const s = document.createElement('script');
          for (const a of old.attributes) s.setAttribute(a.name, a.value);
          s.text = old.text;
          old.replaceWith(s);
        });
      }
    },

    /** تُستدعى بعد كل جولة. تُرجع Promise دائماً (لا تُعطّل اللعبة أبداً). */
    onGameOver() {
      gamesPlayed++;
      const c = CONFIG.interstitial;
      if (!ready(c) || !budgetLeft(c)) return Promise.resolve(false);
      if (gamesPlayed % c.everyNGames !== 0) return Promise.resolve(false);
      return run(c).then((ok) => { if (ok) mark(); return ok; })
                   .catch(() => false);
    },

    /** هل زر "شاهد إعلاناً" قابل للعرض الآن؟ */
    canReward() {
      const c = CONFIG.rewarded;
      return ready(c) && budgetLeft(c);
    },

    /** إعلان المكافأة: يُحل بـ true فقط إذا شُوهد الإعلان فعلاً. */
    showRewarded() {
      const c = CONFIG.rewarded;
      if (!this.canReward()) return Promise.resolve(false);
      return run(c).then((ok) => { if (ok) mark(); return ok; })
                   .catch(() => false);
    }
  };

  return api;
})();
