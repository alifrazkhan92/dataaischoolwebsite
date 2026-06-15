#!/usr/bin/env python3
"""
Update the Latest Post section on index.html AND prepend a card to blog.html.
Called by the social-share GitHub Action after a new blog post is pushed.

Usage:
  python scripts/update_homepage_post.py blog/my-new-post.html
"""
import os
import sys
from bs4 import BeautifulSoup

BASE_URL    = 'https://www.dataaischool.com'
INDEX_FILE  = 'index.html'
BLOG_FILE   = 'blog.html'
GRID_MARKER = '<div class="blog-grid"'
START_TAG   = '<!-- LATEST-POST-START -->'
END_TAG     = '<!-- LATEST-POST-END -->'


def parse_post(filepath):
    with open(filepath, encoding='utf-8') as f:
        soup = BeautifulSoup(f.read(), 'html.parser')

    def og(prop):
        tag = soup.find('meta', property=f'og:{prop}')
        return tag['content'].strip() if tag and tag.get('content') else ''

    def meta(name):
        tag = soup.find('meta', attrs={'name': name})
        return tag['content'].strip() if tag and tag.get('content') else ''

    filename = os.path.basename(filepath)
    rel_path = f'blog/{filename}'

    title   = og('title') or (soup.title.string.strip() if soup.title else filename)
    desc    = og('description') or meta('description') or ''
    url     = rel_path
    image   = og('image') or f'{BASE_URL}/images/og-default.jpg'

    # Derive local image path from og:image
    if image.startswith(BASE_URL):
        image_local = image.replace(BASE_URL + '/', '')
    else:
        image_local = 'images/og-default.jpg'

    # Read blog-tag, date, read-time from the post's own meta if present
    tag_el   = soup.find(class_='blog-tag')
    date_el  = soup.find('time', class_='blog-date')
    rt_el    = soup.find(class_='blog-read-time')
    auth_el  = soup.find(class_='blog-author')

    tag_text  = tag_el.get_text(strip=True)  if tag_el  else 'Blog'
    date_iso  = date_el.get('datetime', '')  if date_el else ''
    date_disp = date_el.get_text(strip=True) if date_el else ''
    read_time = rt_el.get_text(strip=True)   if rt_el   else ''
    author    = auth_el.get_text(strip=True) if auth_el else 'DAIS'

    return {
        'title': title, 'desc': desc, 'url': url,
        'image_local': image_local, 'image_full': image,
        'tag': tag_text, 'date_iso': date_iso,
        'date_disp': date_disp, 'read_time': read_time,
        'author': author,
    }


def build_section(p):
    read_time_html = (
        f'\n         <span class="blog-read-time">{p["read_time"]}</span>'
        if p['read_time'] else ''
    )
    return f''' <!-- LATEST-POST-START -->
 <section class="content-section latest-post-section">
   <div class="latest-post-kicker">&#128218; Latest from the Blog</div>
   <div class="latest-post-card">
     <a href="{p['url']}" class="latest-post-img" aria-hidden="true" tabindex="-1">
       <img src="{p['image_local']}" alt="" width="420" height="260" loading="lazy">
     </a>
     <div class="latest-post-body">
       <div class="latest-post-meta">
         <span class="blog-tag">{p['tag']}</span>
         <time class="blog-date" datetime="{p['date_iso']}">{p['date_disp']}</time>{read_time_html}
       </div>
       <h2 class="latest-post-title">
         <a href="{p['url']}">{p['title']}</a>
       </h2>
       <p class="latest-post-excerpt">{p['desc']}</p>
       <div class="latest-post-footer">
         <span class="blog-author">{p['author']}</span>
         <div class="latest-post-actions">
           <a href="{p['url']}" class="btn btn-primary latest-post-btn">Read the article</a>
           <a href="blog.html" class="btn btn-secondary latest-post-btn">All articles</a>
         </div>
       </div>
     </div>
   </div>
 </section>
 <!-- LATEST-POST-END -->'''


def update_index(new_section):
    with open(INDEX_FILE, encoding='utf-8') as f:
        content = f.read()

    if START_TAG not in content or END_TAG not in content:
        print(f'Warning: markers not found in {INDEX_FILE} — skipping homepage update')
        return False

    start = content.index(START_TAG)
    end   = content.index(END_TAG) + len(END_TAG)
    updated = content[:start] + new_section + content[end:]

    with open(INDEX_FILE, 'w', encoding='utf-8') as f:
        f.write(updated)

    print(f'Updated {INDEX_FILE} with latest post')
    return True


def build_blog_card(p):
    """HTML card for blog.html grid."""
    filename = os.path.basename(p['url'])
    img_src  = p['image_local']
    read_time_html = (
        f'\n <span class="blog-read-time">{p["read_time"]}</span>'
        if p['read_time'] else ''
    )
    return (
        f'\n <!-- Auto-added: {p["title"]} -->\n'
        f' <article class="blog-card">\n'
        f' <div class="blog-card-img">\n'
        f' <img src="{img_src}" alt="{p["title"]}" loading="lazy"/>\n'
        f' </div>\n'
        f' <div class="blog-card-body">\n'
        f' <div class="blog-card-meta">\n'
        f' <span class="blog-tag">{p["tag"]}</span>\n'
        f' <time class="blog-date" datetime="{p["date_iso"]}">{p["date_disp"]}</time>{read_time_html}\n'
        f' </div>\n'
        f' <h2><a href="{p["url"]}">{p["title"]}</a></h2>\n'
        f' <p>{p["desc"]}</p>\n'
        f' <div class="blog-card-footer">\n'
        f' <span class="blog-author">{p["author"]}</span>\n'
        f' <a href="{p["url"]}" class="blog-read-more">Read more &#8594;</a>\n'
        f' </div>\n'
        f' </div>\n'
        f' </article>\n'
    )


def update_blog_listing(p):
    """Prepend a blog card to blog.html if the post isn't already listed."""
    if not os.path.exists(BLOG_FILE):
        print(f'Warning: {BLOG_FILE} not found — skipping blog listing update')
        return False

    with open(BLOG_FILE, encoding='utf-8') as f:
        content = f.read()

    filename = os.path.basename(p['url'])
    if filename in content:
        print(f'{BLOG_FILE} already contains {filename} — skipping')
        return False

    # Insert after the opening <div class="blog-grid" ...> line
    grid_pos = content.find(GRID_MARKER)
    if grid_pos == -1:
        print(f'Warning: blog-grid marker not found in {BLOG_FILE} — skipping')
        return False

    # Find the end of that opening tag line
    insert_pos = content.index('\n', grid_pos) + 1
    card = build_blog_card(p)
    updated = content[:insert_pos] + card + content[insert_pos:]

    with open(BLOG_FILE, 'w', encoding='utf-8') as f:
        f.write(updated)

    print(f'Prepended blog card to {BLOG_FILE}')
    return True


def _safe_blog_path(raw):
    """Return the real path only if it resolves inside blog/. Rejects traversal attempts."""
    allowed = os.path.realpath('blog')
    real    = os.path.realpath(raw)
    if real.startswith(allowed + os.sep) or real == allowed:
        return real
    print(f'Skipping unsafe path (outside blog/): {raw}')
    return None


def main():
    candidates = [f for f in sys.argv[1:] if f.endswith('.html') and os.path.exists(f)]
    if not candidates:
        env_files  = os.environ.get('NEW_FILES', '').strip().split()
        candidates = [f for f in env_files if f.endswith('.html') and os.path.exists(f)]

    files = [p for f in candidates for p in [_safe_blog_path(f)] if p]

    if not files:
        print('No blog post file provided — skipping homepage update')
        return

    # Use the first (newest) file
    filepath = files[0]
    print(f'Updating homepage with: {filepath}')
    post = parse_post(filepath)
    section = build_section(post)
    update_index(section)
    update_blog_listing(post)


if __name__ == '__main__':
    main()
