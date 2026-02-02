/**
 * The Data and AI School of London - Shared scripts
 */

(function () {
  "use strict";

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
