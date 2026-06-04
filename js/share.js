/**
 * DAIS Blog — Social Share Buttons
 * Reads og:url and og:title from the page's meta tags.
 * Populates every .blog-share element with share buttons.
 * No API keys or external dependencies.
 */
(function () {
  'use strict';

  var PLATFORMS = [
    {
      id: 'facebook',
      label: 'Facebook',
      popup: true,
      href: function (eu) {
        return 'https://www.facebook.com/sharer/sharer.php?u=' + eu;
      },
      svg: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><path d="M18 2h-3a5 5 0 00-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 011-1h3z"/></svg>',
    },
    {
      id: 'linkedin',
      label: 'LinkedIn',
      popup: true,
      href: function (eu) {
        return 'https://www.linkedin.com/sharing/share-offsite/?url=' + eu;
      },
      svg: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><path d="M16 8a6 6 0 016 6v7h-4v-7a2 2 0 00-2-2 2 2 0 00-2 2v7h-4v-7a6 6 0 016-6z"/><rect x="2" y="9" width="4" height="12"/><circle cx="4" cy="4" r="2"/></svg>',
    },
    {
      id: 'twitter',
      label: 'X',
      popup: true,
      href: function (eu, et) {
        return 'https://twitter.com/intent/tweet?url=' + eu + '&text=' + et;
      },
      svg: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>',
    },
    {
      id: 'whatsapp',
      label: 'WhatsApp',
      popup: false,
      href: function (eu, et) {
        return 'https://wa.me/?text=' + et + '%20' + eu;
      },
      svg: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>',
    },
    {
      id: 'email',
      label: 'Email',
      popup: false,
      href: function (eu, et) {
        return 'mailto:?subject=' + et + '&body=I%20thought%20you%20might%20find%20this%20useful%3A%0A%0A' + eu;
      },
      svg: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 01-2.06 0L2 7"/></svg>',
    },
  ];

  var COPY_SVG =
    '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/>' +
    '<path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/>' +
    '</svg>';

  function getPageMeta() {
    var urlTag   = document.querySelector('meta[property="og:url"]');
    var titleTag = document.querySelector('meta[property="og:title"]');
    var url   = (urlTag   && urlTag.content)   || location.href;
    var title = (titleTag && titleTag.content) || document.title;
    return {
      url:   url,
      title: title,
      eu:    encodeURIComponent(url),
      et:    encodeURIComponent(title),
    };
  }

  function buildHTML(meta) {
    var btns = PLATFORMS.map(function (p) {
      var href = p.href(meta.eu, meta.et);
      var target = p.popup ? ' target="_blank" rel="noopener noreferrer"' : '';
      return (
        '<a href="' + href + '" class="blog-share-btn blog-share-' + p.id + '"' + target +
        ' aria-label="Share on ' + p.label + '" title="Share on ' + p.label + '">' +
        p.svg +
        '<span>' + p.label + '</span>' +
        '</a>'
      );
    }).join('');

    var copyBtn =
      '<button type="button" class="blog-share-btn blog-share-copy"' +
      ' aria-label="Copy link" title="Copy link">' +
      COPY_SVG + '<span>Copy link</span></button>';

    return (
      '<div class="blog-share-inner">' +
      '<span class="blog-share-label">Share this article</span>' +
      '<div class="blog-share-btns">' + btns + copyBtn + '</div>' +
      '</div>'
    );
  }

  function showCopied(btn) {
    var span = btn.querySelector('span');
    var orig = span.textContent;
    span.textContent = 'Copied!';
    btn.classList.add('blog-share-copied');
    setTimeout(function () {
      span.textContent = orig;
      btn.classList.remove('blog-share-copied');
    }, 2000);
  }

  function copyToClipboard(text, btn) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        showCopied(btn);
      }).catch(function () { fallback(text, btn); });
    } else {
      fallback(text, btn);
    }
  }

  function fallback(text, btn) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    try { document.execCommand('copy'); showCopied(btn); } catch (e) {}
    document.body.removeChild(ta);
  }

  function init() {
    var els = document.querySelectorAll('.blog-share');
    if (!els.length) return;

    var meta = getPageMeta();
    var html = buildHTML(meta);

    els.forEach(function (el) {
      el.innerHTML = html;
    });

    document.querySelectorAll('.blog-share-copy').forEach(function (btn) {
      btn.addEventListener('click', function () {
        copyToClipboard(meta.url, btn);
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}());
