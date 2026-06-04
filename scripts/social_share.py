#!/usr/bin/env python3
"""
DAIS Blog Auto-Share
====================
Reads og: meta tags from new blog posts and publishes them to
Facebook, Instagram and LinkedIn.

Called by .github/workflows/social-share.yml with environment variables:
  NEW_FILES             — space-separated list of blog/*.html paths
  FB_PAGE_ACCESS_TOKEN  — Facebook Page access token
  FB_PAGE_ID            — Facebook Page ID (numeric string)
  IG_USER_ID            — Instagram Business User ID (numeric string)
  LI_ACCESS_TOKEN       — LinkedIn OAuth access token
  LI_AUTHOR_URN         — urn:li:person:XXX  or  urn:li:organization:XXX

See SOCIAL_MEDIA_SETUP.md for how to obtain each credential.
"""

import os
import sys
import time
import requests
from bs4 import BeautifulSoup

BASE_URL = 'https://www.dataaischool.com'

HASHTAGS = (
    '#DataScience #AI #MachineLearning #DigitalSkills #London '
    '#NCFE #OnlineLearning #TechEducation #Python #DataAI #DAIS'
)


# ── Metadata extraction ───────────────────────────────────────────────────────

def parse_blog_post(filepath):
    """Return a dict with title, description, url and image from og: tags."""
    with open(filepath, 'r', encoding='utf-8') as f:
        soup = BeautifulSoup(f.read(), 'html.parser')

    def og(prop):
        tag = soup.find('meta', property=f'og:{prop}')
        return tag['content'].strip() if tag and tag.get('content') else ''

    def meta_name(name):
        tag = soup.find('meta', attrs={'name': name})
        return tag['content'].strip() if tag and tag.get('content') else ''

    filename  = os.path.basename(filepath)
    title     = og('title')       or (soup.title.string.strip() if soup.title else '') or filename
    desc      = og('description') or meta_name('description') or ''
    url       = og('url')         or f'{BASE_URL}/blog/{filename}'
    image     = og('image')       or f'{BASE_URL}/images/og-default.jpg'

    # Ensure image URL is absolute
    if image.startswith('/'):
        image = BASE_URL + image

    # Security: reject URLs that do not belong to the DAIS domain
    if not url.startswith(BASE_URL):
        url = f'{BASE_URL}/blog/{filename}'
    if not image.startswith(BASE_URL):
        image = f'{BASE_URL}/images/og-default.jpg'

    return {'title': title, 'description': desc, 'url': url, 'image': image}


def post_text(post):
    """Full post body used on Facebook and LinkedIn."""
    return (
        f"New article from The Data and AI School of London\n\n"
        f"{post['title']}\n\n"
        f"{post['description']}\n\n"
        f"Read the full article: {post['url']}\n\n"
        f"{HASHTAGS}"
    )


# ── Facebook ──────────────────────────────────────────────────────────────────

def share_facebook(post, token, page_id):
    """Post to a Facebook Page feed with a link preview."""
    resp = requests.post(
        f'https://graph.facebook.com/v19.0/{page_id}/feed',
        data={
            'message':      post_text(post),
            'link':         post['url'],
            'access_token': token,
        },
        timeout=30,
    )
    data = resp.json()
    if resp.ok and 'id' in data:
        print(f'  Facebook posted: {data["id"]}')
        return True
    print(f'  Facebook error: {data.get("error", data)}')
    return False


# ── Instagram ─────────────────────────────────────────────────────────────────

def share_instagram(post, token, ig_user_id):
    """
    Post to Instagram Business account.
    Instagram does not allow clickable links in captions — direct readers
    to the link-in-bio instead.
    Requires an image (uses og:image from the blog post).
    """
    caption = (
        f"{post['title']}\n\n"
        f"{post['description']}\n\n"
        f"Full article at the link in our bio.\n\n"
        f"{HASHTAGS}"
    )

    # Step 1: create media container
    r1 = requests.post(
        f'https://graph.facebook.com/v19.0/{ig_user_id}/media',
        data={
            'image_url':    post['image'],
            'caption':      caption,
            'access_token': token,
        },
        timeout=30,
    )
    d1 = r1.json()
    if not r1.ok or 'id' not in d1:
        print(f'  Instagram container error: {d1.get("error", d1)}')
        return False

    container_id = d1['id']

    # Wait for the media to be processed by Meta's servers
    print('  Instagram: waiting for media processing...')
    for attempt in range(6):
        time.sleep(5)
        status_resp = requests.get(
            f'https://graph.facebook.com/v19.0/{container_id}',
            params={'fields': 'status_code', 'access_token': token},
            timeout=15,
        )
        status = status_resp.json().get('status_code', '')
        if status == 'FINISHED':
            break
        if status == 'ERROR':
            print(f'  Instagram: media processing failed (attempt {attempt+1})')
            return False

    # Step 2: publish the container
    r2 = requests.post(
        f'https://graph.facebook.com/v19.0/{ig_user_id}/media_publish',
        data={
            'creation_id':  container_id,
            'access_token': token,
        },
        timeout=30,
    )
    d2 = r2.json()
    if r2.ok and 'id' in d2:
        print(f'  Instagram posted: {d2["id"]}')
        return True
    print(f'  Instagram publish error: {d2.get("error", d2)}')
    return False


# ── LinkedIn ──────────────────────────────────────────────────────────────────

def share_linkedin(post, token, author_urn):
    """
    Share an article on LinkedIn using the UGC Posts API.
    author_urn can be:
      urn:li:person:XXXXXX          — personal profile
      urn:li:organization:XXXXXX    — company / school page
    """
    payload = {
        'author': author_urn,
        'lifecycleState': 'PUBLISHED',
        'specificContent': {
            'com.linkedin.ugc.ShareContent': {
                'shareCommentary': {
                    'text': post_text(post),
                },
                'shareMediaCategory': 'ARTICLE',
                'media': [{
                    'status':      'READY',
                    'originalUrl': post['url'],
                    'title':       {'text': post['title'][:200]},
                    'description': {'text': post['description'][:256]},
                }],
            }
        },
        'visibility': {
            'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC',
        },
    }

    resp = requests.post(
        'https://api.linkedin.com/v2/ugcPosts',
        json=payload,
        headers={
            'Authorization':              f'Bearer {token}',
            'Content-Type':               'application/json',
            'X-Restli-Protocol-Version':  '2.0.0',
        },
        timeout=30,
    )

    if resp.status_code in (200, 201):
        post_id = resp.headers.get('X-RestLi-Id', resp.headers.get('Location', 'ok'))
        print(f'  LinkedIn posted: {post_id}')
        return True
    print(f'  LinkedIn error {resp.status_code}: {resp.text[:300]}')
    return False


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    new_files_env = os.environ.get('NEW_FILES', '').strip()
    if not new_files_env:
        print('No new blog files — nothing to share.')
        return

    files = [f for f in new_files_env.split() if f.endswith('.html')]
    if not files:
        print('No .html files in NEW_FILES — nothing to share.')
        return

    fb_token   = os.environ.get('FB_PAGE_ACCESS_TOKEN', '').strip()
    fb_page    = os.environ.get('FB_PAGE_ID', '').strip()
    ig_user    = os.environ.get('IG_USER_ID', '').strip()
    li_token   = os.environ.get('LI_ACCESS_TOKEN', '').strip()
    li_author  = os.environ.get('LI_AUTHOR_URN', '').strip()

    errors = []

    for filepath in files:
        if not os.path.exists(filepath):
            print(f'File not found: {filepath} — skipping')
            continue

        post = parse_blog_post(filepath)
        print(f'\nSharing: {post["title"]}')
        print(f'  URL:   {post["url"]}')
        print(f'  Image: {post["image"]}')

        # Facebook
        if fb_token and fb_page:
            ok = share_facebook(post, fb_token, fb_page)
            if not ok:
                errors.append(f'Facebook: {filepath}')
        else:
            print('  Facebook: FB_PAGE_ACCESS_TOKEN or FB_PAGE_ID not set — skipped')

        # Instagram (uses the same FB Page Access Token)
        if fb_token and ig_user:
            ok = share_instagram(post, fb_token, ig_user)
            if not ok:
                errors.append(f'Instagram: {filepath}')
        else:
            print('  Instagram: FB_PAGE_ACCESS_TOKEN or IG_USER_ID not set — skipped')

        # LinkedIn
        if li_token and li_author:
            ok = share_linkedin(post, li_token, li_author)
            if not ok:
                errors.append(f'LinkedIn: {filepath}')
        else:
            print('  LinkedIn: LI_ACCESS_TOKEN or LI_AUTHOR_URN not set — skipped')

    if errors:
        print(f'\nCompleted with errors on: {", ".join(errors)}')
        sys.exit(1)
    else:
        print('\nAll platforms updated successfully.')


if __name__ == '__main__':
    main()
