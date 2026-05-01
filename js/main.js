/**
 * The Data and AI School of London - Shared scripts
 */

(function () {
  "use strict";

  const THEME_KEY = "data-ai-school-theme";
  const THEMES = ["dark", "light", "system"];

  function getStoredTheme() {
    try {
      return localStorage.getItem(THEME_KEY) || "light";
    } catch (e) {
      return "light";
    }
  }

  function setStoredTheme(theme) {
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch (e) {}
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

  // Mobile nav toggle
  const menuToggle = document.querySelector(".menu-toggle");
  const navMain = document.querySelector(".nav-main");
  if (menuToggle && navMain) {
    menuToggle.addEventListener("click", function () {
      navMain.classList.toggle("is-open");
      const expanded = navMain.classList.contains("is-open");
      menuToggle.setAttribute("aria-expanded", expanded);
      menuToggle.textContent = expanded ? "Close menu" : "Menu";
    });
  }

  // Mark current page in nav
  const currentPath =
    window.location.pathname.replace(/^\//, "") || "index.html";
  document.querySelectorAll(".nav-main a").forEach(function (link) {
    const href = link.getAttribute("href") || "";
    if (href === currentPath || (currentPath === "" && href === "index.html")) {
      link.setAttribute("aria-current", "page");
    }
  });

  // Smooth scroll for anchor links
  document.querySelectorAll('a[href^="#"]').forEach(function (anchor) {
    anchor.addEventListener("click", function (e) {
      const id = this.getAttribute("href");
      if (id === "#") return;
      const target = document.querySelector(id);
      if (target) {
        e.preventDefault();
        target.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
  });

  // Form submit feedback (optional)
  const contactForm = document.querySelector(".contact-form, .apply-form");
  if (contactForm) {
    contactForm.addEventListener("submit", function (e) {
      // Allow default submit; could add fetch() here for AJAX
      const btn = contactForm.querySelector('button[type="submit"]');
      if (btn) {
        btn.disabled = true;
        btn.textContent = "Sending…";
        setTimeout(function () {
          btn.disabled = false;
          btn.textContent = btn.dataset.originalText || "Send";
        }, 2000);
      }
    });
  }
})();
