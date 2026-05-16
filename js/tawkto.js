/**
 * Tawk.to live chat loader for The Data and AI School of London.
 * Loaded as an external script so it does not violate the script-src CSP
 * (no 'unsafe-inline' needed). Replicates the original Tawk.to embed code
 * exactly: sets up Tawk_API namespace and Tawk_LoadStart before dynamically
 * inserting the widget script at the top of the document.
 */
(function () {
  window.Tawk_API = window.Tawk_API || {};
  window.Tawk_LoadStart = new Date();

  var s1 = document.createElement("script");
  var s0 = document.getElementsByTagName("script")[0];
  s1.async = true;
  s1.src = "https://embed.tawk.to/6997b37fa5c7cc1c3718a9ee/1jhs9aagd";
  s1.charset = "UTF-8";
  s1.setAttribute("crossorigin", "*");
  s0.parentNode.insertBefore(s1, s0);
})();
