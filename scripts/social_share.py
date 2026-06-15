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
    # SEC-011: updated from deprecated v19.0 to v22.0
    resp = requests.post(
        f'https://graph.facebook.com/v22.0/{page_id}/feed',
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
    # SEC-010: log only the error message field, not raw token-bearing error response
    err = data.get('error', {})
    code = err.get('code', '?')
    msg  = err.get('message', 'unknown')
    print(f'  Facebook error [{code}]: {msg}')
    if str(code) == '368':
        print('  ACTION REQUIRED: Facebook has blocked posting — identity verification needed.')
        print('  Fix: Open the Facebook app on your phone, complete any verification prompts,')
        print('  then regenerate FB_PAGE_ACCESS_TOKEN and update the GitHub secret.')
        print('  See: https://developers.facebook.com/tools/explorer/')
    elif str(code) == '190':
        print('  ACTION REQUIRED: FB_PAGE_ACCESS_TOKEN has expired or is invalid.')
        print('  Fix: Regenerate the token at https://developers.facebook.com/tools/explorer/')
        print('  and update the FB_PAGE_ACCESS_TOKEN GitHub secret.')
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
    # SEC-011: updated from deprecated v19.0 to v22.0
    r1 = requests.post(
        f'https://graph.facebook.com/v22.0/{ig_user_id}/media',
        data={
            'image_url':    post['image'],
            'caption':      caption,
            'access_token': token,
        },
        timeout=30,
    )
    d1 = r1.json()
    if not r1.ok or 'id' not in d1:
        # SEC-010: log only the error message, not raw response (may contain token metadata)
        err = d1.get('error', {})
        print(f'  Instagram container error [{err.get("code","?")}]: {err.get("message","unknown")}')
        return False

    container_id = d1['id']

    # Wait for the media to be processed by Meta's servers
    # SEC-012: added max 20 attempts (100s total) to prevent infinite loop
    print('  Instagram: waiting for media processing...')
    MAX_POLL_ATTEMPTS = 20
    for attempt in range(MAX_POLL_ATTEMPTS):
        time.sleep(5)
        status_resp = requests.get(
            f'https://graph.facebook.com/v22.0/{container_id}',
            params={'fields': 'status_code', 'access_token': token},
            timeout=15,
        )
        status = status_resp.json().get('status_code', '')
        if status == 'FINISHED':
            break
        if status == 'ERROR':
            print(f'  Instagram: media processing failed (attempt {attempt+1})')
            return False
        if attempt == MAX_POLL_ATTEMPTS - 1:
            print(f'  Instagram: media processing timed out after {MAX_POLL_ATTEMPTS} attempts')
            return False

    # Step 2: publish the container
    # SEC-011: updated from deprecated v19.0 to v22.0
    r2 = requests.post(
        f'https://graph.facebook.com/v22.0/{ig_user_id}/media_publish',
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
    # SEC-010: log only safe error fields
    err2 = d2.get('error', {})
    print(f'  Instagram publish error [{err2.get("code","?")}]: {err2.get("message","unknown")}')
    return False


# ── LinkedIn ──────────────────────────────────────────────────────────────────

def _validate_li_author_urn(urn):
    """Return an error string if the URN is malformed, or None if it looks valid."""
    valid_prefixes = ('urn:li:person:', 'urn:li:organization:')
    if not any(urn.startswith(p) for p in valid_prefixes):
        return (
            f'LI_AUTHOR_URN "{urn}" has an invalid format.\n'
            '  Expected:  urn:li:organization:XXXXXXXX  (for a LinkedIn Page/company)\n'
            '          or urn:li:person:XXXXXXXX         (for a personal profile)\n'
            '  Common mistake: using "urn:li:company:" — the correct prefix is "urn:li:organization:"\n'
            '  Find your organization ID: go to your LinkedIn Page admin URL,\n'
            '  e.g. linkedin.com/company/SLUG/admin/ → the numeric ID is in Settings.'
        )
    id_part = urn.split(':', 3)[-1]
    if not id_part.isdigit():
        return (
            f'LI_AUTHOR_URN "{urn}" has a non-numeric ID part "{id_part}".\n'
            '  The ID must be a number, e.g. urn:li:organization:12345678'
        )
    return None


def share_linkedin(post, token, author_urn):
    """
    Share an article on LinkedIn using the UGC Posts API.
    author_urn can be:
      urn:li:person:XXXXXX          — personal profile
      urn:li:organization:XXXXXX    — company / school page
    Requires scope w_member_social (personal) or w_organization_social (page).
    """
    urn_error = _validate_li_author_urn(author_urn)
    if urn_error:
        print(f'  LinkedIn: invalid LI_AUTHOR_URN — skipping to avoid wasting API call.')
        print(f'  {urn_error}')
        return False

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
    # SEC-010: only log status code and the 'message' field — never raw response body
    try:
        body    = resp.json()
        err_msg = body.get('message', 'no message field')
    except Exception:
        err_msg = '(non-JSON response)'
    print(f'  LinkedIn error {resp.status_code}: {err_msg}')
    if resp.status_code == 403 and '/author' in err_msg:
        print('  Likely cause: LI_AUTHOR_URN is wrong or the token lacks the required OAuth scope.')
        print('  For a LinkedIn Page: LI_AUTHOR_URN must be urn:li:organization:XXXXXXXX')
        print('  Token scope needed: w_organization_social  (for pages)')
        print('                   or w_member_social        (for personal profiles)')
        print('  Regenerate your token at https://www.linkedin.com/developers/apps and')
        print('  ensure the correct scopes are approved, then update the LI_ACCESS_TOKEN secret.')
    elif resp.status_code == 401:
        print('  ACTION REQUIRED: LI_ACCESS_TOKEN has expired (LinkedIn tokens last ~60 days).')
        print('  Fix: Regenerate at https://www.linkedin.com/developers/apps and update the secret.')
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

    fatal_errors = [e for e in errors if not e.startswith('LinkedIn')]
    if errors:
        print(f'\nCompleted with errors on: {", ".join(errors)}')
    else:
        print('\nAll platforms updated successfully.')
    if fatal_errors:
        sys.exit(1)


if __name__ == '__main__':
    main()
