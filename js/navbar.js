/**
 * DAIS Site Navigation Web Component
 *
 * Usage: include this script synchronously before <site-nav></site-nav> in <body>.
 * main.js (loaded at end of body) then wires up theme toggle, mobile menu and
 * aria-current marking once the navbar is already in the DOM.
 *
 * To change the navbar, edit this file only.
 */

const NAV_HTML = `
<header class="site-header">
  <div class="header-inner">
    <a href="index.html" class="logo">
      <img src="images/logo-dais.svg" alt="The Data and AI School of London" class="logo-img">
    </a>
    <button type="button" class="menu-toggle" aria-expanded="false" aria-controls="nav-main">Menu</button>
    <nav id="nav-main">
      <ul class="nav-main">
        <li><a href="index.html">Home</a></li>
        <li><a href="about.html">About</a></li>
        <li><a href="courses.html">Courses</a></li>
        <li><a href="blog.html">Blog</a></li>
        <li><a href="apply.html">Apply</a></li>
        <li><a href="contact.html">Contact</a></li>
        <li class="nav-portal-item">
          <a href="https://learn.dataaischool.com" class="nav-portal-btn" target="_blank" rel="noopener noreferrer">&#127891; Student Portal</a>
        </li>
        <li class="nav-theme-wrap">
          <button type="button" class="theme-toggle" aria-label="Theme: light" title="Toggle theme (dark / light / system)">
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="4"/>
              <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>
            </svg>
            <span class="theme-toggle-label">Light</span>
          </button>
        </li>
      </ul>
    </nav>
  </div>
</header>
`.trim();

class SiteNav extends HTMLElement {
  connectedCallback() {
    this.innerHTML = NAV_HTML;
  }
}

customElements.define('site-nav', SiteNav);
