/**
 * The Data and AI School of London - Shared scripts
 */

(function () {
  "use strict";

  // ─── Theme ───────────────────────────────────────────────────────────────────

  const THEME_KEY = "data-ai-school-theme";
  const THEMES = ["dark", "light", "system"];

  function getStoredTheme() {
    try { return localStorage.getItem(THEME_KEY) || "light"; } catch (e) { return "light"; }
  }

  function setStoredTheme(theme) {
    try { localStorage.setItem(THEME_KEY, theme); } catch (e) {}
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    const btn = document.querySelector(".theme-toggle");
    if (btn) {
      btn.setAttribute("aria-label", "Theme: " + theme);
      btn.querySelector(".theme-toggle-label").textContent =
        theme.charAt(0).toUpperCase() + theme.slice(1);
    }
  }

  function nextTheme(current) {
    const i = THEMES.indexOf(current);
    return THEMES[(i + 1) % THEMES.length];
  }

  function initTheme() {
    let theme = getStoredTheme();
    if (!THEMES.includes(theme)) theme = "light";
    applyTheme(theme);
    const btn = document.querySelector(".theme-toggle");
    if (btn) {
      btn.addEventListener("click", function () {
        const next = nextTheme(getStoredTheme());
        setStoredTheme(next);
        applyTheme(next);
      });
    }
    window.addEventListener("storage", function (e) {
      if (e.key === THEME_KEY && e.newValue) applyTheme(e.newValue);
    });
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    mq.addEventListener("change", function () {
      if (getStoredTheme() === "system") applyTheme("system");
    });
  }

  initTheme();

  // ─── Cookie Consent (PECR compliant) ─────────────────────────────────────────

  const CONSENT_KEY = "dais-cookie-consent";
  const FONTS_URL =
    "https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap";

  function getConsent() {
    try { return localStorage.getItem(CONSENT_KEY); } catch (e) { return null; }
  }

  function setConsent(value) {
    try { localStorage.setItem(CONSENT_KEY, value); } catch (e) {}
  }

  function loadGoogleFonts() {
    if (document.getElementById("dais-google-fonts")) return;
    var preconnect1 = document.createElement("link");
    preconnect1.rel = "preconnect";
    preconnect1.href = "https://fonts.googleapis.com";
    document.head.appendChild(preconnect1);

    var preconnect2 = document.createElement("link");
    preconnect2.rel = "preconnect";
    preconnect2.href = "https://fonts.gstatic.com";
    preconnect2.crossOrigin = "anonymous";
    document.head.appendChild(preconnect2);

    var link = document.createElement("link");
    link.id = "dais-google-fonts";
    link.rel = "stylesheet";
    link.href = FONTS_URL;
    document.head.appendChild(link);
  }

  function loadTawkTo() {
    if (document.getElementById("dais-tawkto")) return;
    var s1 = document.createElement("script");
    s1.id = "dais-tawkto";
    s1.async = true;
    s1.src = "https://embed.tawk.to/6997b37fa5c7cc1c3718a9ee/1jhs9aagd";
    s1.charset = "UTF-8";
    s1.setAttribute("crossorigin", "*");
    var s0 = document.getElementsByTagName("script")[0];
    s0.parentNode.insertBefore(s1, s0);
  }

  function applyConsent(accepted) {
    if (accepted) {
      loadGoogleFonts();
      loadTawkTo();
    }
  }

  function hideBanner() {
    var banner = document.getElementById("cookie-banner");
    if (banner) {
      banner.setAttribute("aria-hidden", "true");
      banner.style.display = "none";
    }
  }

  function showBanner() {
    var banner = document.getElementById("cookie-banner");
    if (banner) {
      banner.removeAttribute("aria-hidden");
      banner.style.display = "";
    }
  }

  function createBanner() {
    var banner = document.createElement("div");
    banner.id = "cookie-banner";
    banner.setAttribute("role", "region");
    banner.setAttribute("aria-label", "Cookie consent");
    banner.innerHTML =
      '<div class="cookie-banner-inner">' +
        '<p class="cookie-banner-text">' +
          'We use optional cookies to load fonts (Google Fonts) and a live-chat widget (Tawk.to). ' +
          'These send your IP address to third parties. Strictly necessary cookies (e.g. your theme preference) ' +
          'are stored only on your device. ' +
          '<a href="privacy-policy.html#cookies">Cookie policy</a>' +
        '</p>' +
        '<div class="cookie-banner-actions">' +
          '<button type="button" class="btn btn-primary" id="cookie-accept">Accept all</button>' +
          '<button type="button" class="btn btn-secondary" id="cookie-reject">Reject non-essential</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(banner);

    document.getElementById("cookie-accept").addEventListener("click", function () {
      setConsent("accepted");
      applyConsent(true);
      hideBanner();
    });

    document.getElementById("cookie-reject").addEventListener("click", function () {
      setConsent("rejected");
      hideBanner();
    });
  }

  function initCookieConsent() {
    var consent = getConsent();
    if (consent === "accepted") {
      applyConsent(true);
    } else if (consent === null) {
      createBanner();
    }
    // Wire up "Cookie Settings" buttons/links to re-open banner
    document.addEventListener("click", function (e) {
      if (
        e.target &&
        (e.target.id === "open-cookie-settings" ||
          e.target.classList.contains("cookie-settings-inline"))
      ) {
        setConsent(null);
        try { localStorage.removeItem(CONSENT_KEY); } catch (ex) {}
        var existing = document.getElementById("cookie-banner");
        if (existing) {
          showBanner();
        } else {
          createBanner();
        }
      }
    });
  }

  initCookieConsent();

  // ─── Mobile nav toggle ────────────────────────────────────────────────────────

  var menuToggle = document.querySelector(".menu-toggle");
  var navMain = document.querySelector(".nav-main");
  if (menuToggle && navMain) {
    menuToggle.addEventListener("click", function () {
      navMain.classList.toggle("is-open");
      var expanded = navMain.classList.contains("is-open");
      menuToggle.setAttribute("aria-expanded", expanded);
      menuToggle.textContent = expanded ? "Close menu" : "Menu";
    });
  }

  // ─── Mark current page in nav ─────────────────────────────────────────────────

  var currentPath = window.location.pathname.replace(/^\//, "") || "index.html";
  document.querySelectorAll(".nav-main a").forEach(function (link) {
    var href = link.getAttribute("href") || "";
    if (href === currentPath || (currentPath === "" && href === "index.html")) {
      link.setAttribute("aria-current", "page");
    }
  });

  // ─── Smooth scroll for anchor links ──────────────────────────────────────────

  document.querySelectorAll('a[href^="#"]').forEach(function (anchor) {
    anchor.addEventListener("click", function (e) {
      var id = this.getAttribute("href");
      if (id === "#") return;
      var target = document.querySelector(id);
      if (target) {
        e.preventDefault();
        target.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
  });

  // ─── Form submission ──────────────────────────────────────────────────────────

  var form = document.querySelector(".contact-form, .apply-form");
  if (form) {
    form.addEventListener("submit", function (e) {
      var btn = form.querySelector('button[type="submit"]');
      var originalText = btn ? (btn.dataset.originalText || btn.textContent) : "";

      // If no real endpoint is set (action is "#"), prevent and show a message
      if (form.getAttribute("action") === "#") {
        e.preventDefault();
        if (btn) {
          btn.disabled = true;
          btn.textContent = "Submission not yet configured";
          setTimeout(function () {
            btn.disabled = false;
            btn.textContent = originalText;
          }, 3000);
        }
        return;
      }

      if (btn) {
        btn.disabled = true;
        btn.textContent = "Sending…";
      }
    });
  }

})();
