#!/usr/bin/env python3
"""
Update the Latest Post section on index.html.
Called by the social-share GitHub Action after a new blog post is pushed.
Replaces everything between <!-- LATEST-POST-START --> and <!-- LATEST-POST-END -->.

Usage:
  python scripts/update_homepage_post.py blog/my-new-post.html
"""
import os
import sys
from bs4 import BeautifulSoup

BASE_URL   = 'https://www.dataaischool.com'
INDEX_FILE = 'index.html'
START_TAG  = '<!-- LATEST-POST-START -->'
END_TAG    = '<!-- LATEST-POST-END -->'


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


def main():
    files = [f for f in sys.argv[1:] if f.endswith('.html') and os.path.exists(f)]
    if not files:
        env_files = os.environ.get('NEW_FILES', '').strip().split()
        files = [f for f in env_files if f.endswith('.html') and os.path.exists(f)]

    if not files:
        print('No blog post file provided — skipping homepage update')
        return

    # Use the first (newest) file
    filepath = files[0]
    print(f'Updating homepage with: {filepath}')
    post = parse_post(filepath)
    section = build_section(post)
    update_index(section)


if __name__ == '__main__':
    main()
