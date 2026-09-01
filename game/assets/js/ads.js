/*
 * ads.js — طبقة الإعلانات (مصدر الربح).
 * ------------------------------------------------------------------
 * مزوّدان مدعومان في نفس الوقت:
 *
 *   1) Google AdSense — H5 Games Ads (adBreak / adConfig)
 *      إعلان بيني بين الجولات + إعلان مكافأة، مصمّمان أصلاً للألعاب.
 *      يتطلّب تفعيل "H5 Games Ads" في حساب AdSense.
 *      السكربت مُضاف مسبقاً في <head> داخل index.html.
 *
 *   2) شبكة بديلة (Monetag / Adsterra / أي شبكة تعطيك رقم زون أو Direct Link)
 *      تُستخدم تلقائياً إذا لم يكن AdSense متاحاً.
 *
 * القاعدة الذهبية: مهما فشل الإعلان، اللعبة تكمل بشكل طبيعي.
 */
window.Ads = (function () {
  'use strict';

  const CONFIG = {
    /* ---------------- Google AdSense ---------------- */
    adsense: {
      enabled: true,
      client: 'ca-pub-6226134520950898',

      // إعلانات الألعاب (بيني + مكافأة). اجعلها false إن لم تُفعَّل
      // ميزة H5 Games Ads في حسابك بعد.
      gameAds: true,

      // بانر عرضي أسفل اللعبة. يحتاج إنشاء "وحدة إعلانية" في AdSense
      // ووضع رقمها (data-ad-slot) هنا.
      banner: { enabled: false, slot: '' }
    },

    /* ------------- شبكة بديلة (اختيارية) ------------- */
    network: {
      banner:       { enabled: false, html: '' },
      interstitial: { enabled: false, zoneId: '', directLink: '' },
      rewarded:     { enabled: false, zoneId: '', directLink: '' }
    },

    /* ---------------- ضبط التكرار ---------------- */
    interstitialEveryNGames: 3,   // إعلان بيني كل 3 جولات
    minSecondsBetweenAds: 90,
    minSecondsBetweenRewards: 45,
    maxAdsPerSession: 12
  };

  let gamesPlayed = 0;
  let adsShown = 0;
  let lastAdAt = 0;

  const now = () => Date.now() / 1000;

  function budgetLeft(minGap) {
    return adsShown < CONFIG.maxAdsPerSession && now() - lastAdAt >= minGap;
  }
  function mark() { adsShown++; lastAdAt = now(); }

  /* ================= AdSense — H5 Games Ads ================= */

  const hasGameAds = () =>
    CONFIG.adsense.enabled &&
    CONFIG.adsense.gameAds &&
    typeof window.adBreak === 'function';

  /**
   * يعرض فاصلاً إعلانياً من AdSense.
   * يُحل بـ true فقط إذا شاهد اللاعب الإعلان فعلاً.
   */
  function adBreakAsync(opts) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve(v); } };

      // شبكة أمان: لو لم يستجب SDK خلال 30 ثانية نُكمل اللعبة.
      const guard = setTimeout(() => done(false), 30000);

      const base = {
        name: opts.name,
        adBreakDone: () => { clearTimeout(guard); done(false); }
      };

      try {
        if (opts.type === 'reward') {
          window.adBreak(Object.assign(base, {
            type: 'reward',
            // يُستدعى فقط عند توفّر إعلان مكافأة. اللاعب ضغط الزر فعلاً
            // لذا نعرضه مباشرة.
            beforeReward: (showAdFn) => { try { showAdFn(); } catch (e) { done(false); } },
            adViewed:    () => { clearTimeout(guard); done(true); },
            adDismissed: () => { clearTimeout(guard); done(false); }
          }));
        } else {
          window.adBreak(Object.assign(base, {
            type: 'next',
            afterAd: () => { clearTimeout(guard); done(true); }
          }));
        }
      } catch (e) {
        clearTimeout(guard);
        done(false);
      }
    });
  }

  /* ================= الشبكة البديلة ================= */

  const netReady = (c) => c && c.enabled && (c.zoneId || c.directLink);

  function netRun(c) {
    const fn = c.zoneId && window['show_' + c.zoneId];
    if (typeof fn === 'function') {
      try { return Promise.resolve(fn({ type: 'end' })).then(() => true); }
      catch (e) { return Promise.resolve(false); }
    }
    if (c.directLink) {
      // يجب أن يُستدعى داخل حدث نقر وإلا حجبه المتصفح.
      return Promise.resolve(!!window.open(c.directLink, '_blank', 'noopener'));
    }
    return Promise.resolve(false);
  }

  /* ================= البانر ================= */

  function mountBanner() {
    const slot = document.getElementById('ad-banner');
    if (!slot) return;

    const ad = CONFIG.adsense;
    if (ad.enabled && ad.banner.enabled && ad.banner.slot) {
      slot.hidden = false;
      const ins = document.createElement('ins');
      ins.className = 'adsbygoogle';
      ins.style.display = 'block';
      ins.style.width = '100%';
      ins.setAttribute('data-ad-client', ad.client);
      ins.setAttribute('data-ad-slot', ad.banner.slot);
      ins.setAttribute('data-ad-format', 'auto');
      ins.setAttribute('data-full-width-responsive', 'true');
      slot.appendChild(ins);
      try { (window.adsbygoogle = window.adsbygoogle || []).push({}); } catch (e) {}
      return;
    }

    const nb = CONFIG.network.banner;
    if (nb.enabled && nb.html.trim()) {
      slot.hidden = false;
      // innerHTML لا ينفّذ <script>، لذا نعيد إنشاءها يدوياً.
      slot.innerHTML = nb.html;
      slot.querySelectorAll('script').forEach((old) => {
        const s = document.createElement('script');
        for (const a of old.attributes) s.setAttribute(a.name, a.value);
        s.text = old.text;
        old.replaceWith(s);
      });
    }
  }

  /* ================= فحص تشخيصي ================= */

  function diagnose() {
    setTimeout(() => {
      const ad = CONFIG.adsense;
      if (ad.enabled && ad.gameAds && typeof window.adBreak !== 'function') {
        console.warn(
          '[Ads] AdSense H5 Games Ads غير متاح.\n' +
          'الأسباب المحتملة: (1) مانع إعلانات مُفعّل في متصفحك — عطّله للاختبار. ' +
          '(2) الموقع لم يُعتمد بعد في AdSense. ' +
          '(3) ميزة H5 Games Ads غير مُفعّلة في حسابك.\n' +
          'اللعبة تعمل طبيعياً بدون إعلانات في كل الأحوال.'
        );
      }
      Object.entries({ interstitial: CONFIG.network.interstitial, rewarded: CONFIG.network.rewarded })
        .forEach(([k, c]) => {
          if (c.enabled && c.zoneId && !c.directLink && typeof window['show_' + c.zoneId] !== 'function') {
            console.warn(`[Ads] الزون "${c.zoneId}" (${k}) مُفعّل لكن الدالة show_${c.zoneId} غير موجودة.`);
          }
        });
    }, 4000);
  }

  /* ================= الواجهة العامة ================= */

  return {
    init() {
      if (CONFIG.adsense.enabled && CONFIG.adsense.gameAds && typeof window.adConfig === 'function') {
        try {
          window.adConfig({ preloadAdBreaks: 'on', sound: 'off' });
        } catch (e) {}
      }
      mountBanner();
      diagnose();
    },

    /** بعد كل جولة. تُرجع Promise دائماً ولا تُعطّل اللعبة أبداً. */
    onGameOver() {
      gamesPlayed++;
      if (gamesPlayed % CONFIG.interstitialEveryNGames !== 0) return Promise.resolve(false);
      if (!budgetLeft(CONFIG.minSecondsBetweenAds)) return Promise.resolve(false);

      const after = (ok) => { if (ok) mark(); return ok; };

      if (hasGameAds()) {
        return adBreakAsync({ type: 'next', name: 'between-rounds' }).then(after).catch(() => false);
      }
      const c = CONFIG.network.interstitial;
      if (!netReady(c)) return Promise.resolve(false);
      return netRun(c).then(after).catch(() => false);
    },

    /** هل نعرض زر "شاهد إعلاناً وأكمل"؟ */
    canReward() {
      if (!budgetLeft(CONFIG.minSecondsBetweenRewards)) return false;
      return hasGameAds() || netReady(CONFIG.network.rewarded);
    },

    /** إعلان المكافأة: يُحل بـ true فقط إذا شُوهد الإعلان فعلاً. */
    showRewarded() {
      if (!this.canReward()) return Promise.resolve(false);
      const after = (ok) => { if (ok) mark(); return ok; };

      if (hasGameAds()) {
        return adBreakAsync({ type: 'reward', name: 'revive' }).then(after).catch(() => false);
      }
      return netRun(CONFIG.network.rewarded).then(after).catch(() => false);
    }
  };
})();
