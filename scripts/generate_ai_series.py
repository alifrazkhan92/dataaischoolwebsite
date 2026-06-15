#!/usr/bin/env python3
"""
DAIS AI Engineering Series Generator
=====================================
Runs every Saturday morning. Reads scripts/ai_engineering_curriculum.json,
determines the next episode, generates a full tutorial blog post with Claude,
creates an Imagen 3 hero image, then calls generate_blog_video.py with
VIDEO_DURATION_MINS=15 to produce a 15-minute narrated video and upload it
to YouTube.

Environment variables required:
  ANTHROPIC_API_KEY      -- Claude for blog content + video script
  GEMINI_API_KEY         -- Imagen 3 hero image (falls back to Pillow)
  ELEVENLABS_API_KEY     -- ElevenLabs TTS
  ELEVENLABS_VOICE_ID    -- ElevenLabs voice ID
  YOUTUBE_CLIENT_ID      -- Google OAuth client ID
  YOUTUBE_CLIENT_SECRET  -- Google OAuth client secret
  YOUTUBE_REFRESH_TOKEN  -- YouTube refresh token
  YOUTUBE_AI_SERIES_PLAYLIST_ID  -- (optional) created on first run, save to secrets
  FB_PAGE_ACCESS_TOKEN, FB_PAGE_ID, IG_USER_ID, LI_ACCESS_TOKEN, LI_AUTHOR_URN
"""

import os
import sys
import json
import re
import subprocess
import urllib.parse
import datetime
import textwrap
from pathlib import Path

# ── Paths ─────────────────────────────────────────────────────────────────────

REPO_ROOT     = Path(__file__).resolve().parent.parent
BLOG_DIR      = REPO_ROOT / "blog"
IMAGES_DIR    = REPO_ROOT / "images"
CURRICULUM    = REPO_ROOT / "scripts" / "ai_engineering_curriculum.json"
BLOG_LISTING  = REPO_ROOT / "blog.html"
SITEMAP       = REPO_ROOT / "sitemap.xml"
BASE_URL      = "https://www.dataaischool.com"
TODAY         = datetime.date.today().isoformat()

# ── Optional imports ──────────────────────────────────────────────────────────

try:
    from google import genai as google_genai
    from google.genai import types as google_genai_types
    GOOGLE_GENAI_AVAILABLE = True
except ImportError:
    GOOGLE_GENAI_AVAILABLE = False
    print("WARNING: google-genai not installed. Imagen 3 unavailable; will use Pillow fallback.")

try:
    from PIL import Image, ImageDraw, ImageFont
    PIL_AVAILABLE = True
except ImportError:
    PIL_AVAILABLE = False
    print("WARNING: Pillow not installed. Fallback image generation unavailable.")


# ── Curriculum helpers ────────────────────────────────────────────────────────

def load_curriculum():
    if not CURRICULUM.exists():
        print(f"Curriculum not found: {CURRICULUM}")
        sys.exit(1)
    with open(CURRICULUM, encoding="utf-8") as f:
        return json.load(f)


def current_episode_number():
    """Count existing ai-eng-ep*.html files to determine the next episode."""
    existing = sorted(BLOG_DIR.glob("ai-eng-ep*.html"))
    return len(existing)


def blog_filename(episode):
    slug = episode["slug"]
    n    = episode["episode"]
    return f"ai-eng-ep{n:02d}-{slug}.html"


# ── Blog content generation ───────────────────────────────────────────────────

def generate_blog_content(episode, api_key):
    """Use Claude Sonnet to write a full tutorial blog post body in HTML."""
    import anthropic

    client = anthropic.Anthropic(api_key=api_key)

    ep_type = episode.get("type", "tutorial")
    title   = episode["title"]
    brief   = episode.get("content_brief", "")
    tag     = episode.get("tag", "AI Engineering")
    ep_num  = episode["episode"]
    series  = "AI Engineering: Zero to Master"

    if ep_type == "roadmap":
        style_instruction = (
            "This is Episode 0: the series overview and roadmap. "
            "Write a comprehensive, motivating introduction to the entire series. "
            "Include a visual-style curriculum overview with all 27 episodes listed. "
        )
    elif ep_type == "capstone":
        style_instruction = (
            f"This is Episode {ep_num}: the capstone career episode. "
            "Write an inspiring and practical career guide for AI engineering in the UK. "
        )
    else:
        style_instruction = (
            f"This is Episode {ep_num} of {series}. "
            "Write a detailed, hands-on technical tutorial with Python code examples. "
            "Include practical exercises readers can complete immediately. "
        )

    prompt = f"""You are writing a comprehensive educational blog post for The Data and AI School of London.

Series: {series}
Episode: {ep_num}
Title: {title}
Tag: {tag}
Content brief: {brief}

{style_instruction}

Requirements:
- British English throughout
- No em dashes or en dashes: use commas, colons or full stops instead
- Length: 1800 to 2400 words of body content
- Professional, clear and authoritative tone for UK tech professionals and career changers
- Structured with clear h2 and h3 headings
- Include practical Python code examples in <pre><code class="language-python"> tags where relevant
- Include a "Key Takeaways" section at the end
- Do NOT include the main h1 title (it is added separately)
- Do NOT include navigation, headers or footers
- Use <p>, <h2>, <h3>, <ul>, <ol>, <li>, <strong>, <em>, <pre>, <code> tags only
- Make every section genuinely useful and educational, not just an overview

Return ONLY the HTML body content starting with the first <p> or <h2> tag. No markdown, no code fences, no extra text."""

    msg  = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=5000,
        messages=[{"role": "user", "content": prompt}],
    )
    body = msg.content[0].text.strip()

    # Strip accidental markdown code fences
    m = re.search(r"```(?:html)?\s*([\s\S]+?)\s*```", body)
    if m:
        body = m.group(1)

    return body


# ── Hero image generation ─────────────────────────────────────────────────────

def generate_hero_image_imagen(episode, gemini_key):
    """Generate a 16:9 hero image via Google Imagen 3."""
    if not GOOGLE_GENAI_AVAILABLE:
        raise RuntimeError("google-genai package not installed")

    slug   = episode["slug"]
    fname  = f"blog-{slug}.png"
    out    = IMAGES_DIR / fname
    prompt = (
        f"Professional hero image for a UK technology education blog: '{episode['title']}'. "
        f"{episode.get('image_prompt', 'Modern AI engineering workspace, navy blue and gold professional theme')}. "
        "Photorealistic, high quality, corporate professional style. "
        "No text, no words, no logos in the image."
    )

    client   = google_genai.Client(api_key=gemini_key)
    response = client.models.generate_images(
        model="imagen-3.0-generate-002",
        prompt=prompt[:2000],
        config=google_genai_types.GenerateImagesConfig(
            number_of_images=1,
            aspect_ratio="16:9",
        )
    )
    image_bytes = response.generated_images[0].image.image_bytes
    out.write_bytes(image_bytes)
    print(f"Imagen 3 hero image: {fname} ({out.stat().st_size // 1024}KB)")
    return fname


def generate_hero_image_pillow(episode):
    """Branded fallback hero image when Imagen 3 is unavailable."""
    if not PIL_AVAILABLE:
        return None

    slug  = episode["slug"]
    fname = f"blog-{slug}.png"
    out   = IMAGES_DIR / fname
    W, H  = 1200, 630

    img  = Image.new("RGB", (W, H), (8, 20, 60))
    draw = ImageDraw.Draw(img)

    for y in range(H):
        t = y / H
        draw.line([(0, y), (W, y)], fill=(int(8 + t * 15), int(20 + t * 25), int(60 + t * 20)))
    for x in range(0, W, 60):
        draw.line([(x, 0), (x, H)], fill=(16, 38, 85))
    for y2 in range(0, H, 60):
        draw.line([(0, y2), (W, y2)], fill=(16, 38, 85))

    try:
        fbold  = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 42)
        fbold2 = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 28)
        fsub   = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 17)
        fbrand = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 13)
    except Exception:
        fbold = fbold2 = fsub = fbrand = ImageFont.load_default()

    draw.rectangle([0, 582, W, 630], fill=(10, 24, 68))
    draw.rectangle([0, 578, W, 582], fill=(215, 162, 35))

    tag_text = episode.get("tag", "AI Engineering").upper()
    draw.rounded_rectangle([40, 55, 40 + len(tag_text) * 9 + 24, 83], radius=11, fill=(170, 120, 15))
    draw.text((52, 61), tag_text, fill=(255, 240, 195), font=fbrand)

    title  = episode["title"]
    lines  = textwrap.wrap(title, width=38)
    colors = [(255, 255, 255), (95, 195, 255), (255, 255, 255), (210, 210, 210)]
    for i, line in enumerate(lines[:4]):
        draw.text((40, 100 + i * 56), line, fill=colors[i % len(colors)],
                  font=(fbold if i < 2 else fbold2))

    sub_lines = textwrap.wrap(episode.get("og_description", "")[:120], width=62)
    for i, sl in enumerate(sub_lines[:3]):
        draw.text((40, 360 + i * 28), sl, fill=(185, 185, 185), font=fsub)

    draw.text((40, 596), "The Data and AI School of London", fill=(215, 162, 35), font=fbrand)
    draw.text((W - 242, 596), "www.dataaischool.com", fill=(155, 175, 215), font=fbrand)

    img.save(out, "PNG")
    print(f"Pillow fallback hero image: {fname} ({out.stat().st_size // 1024}KB)")
    return fname


def generate_hero_image(episode):
    gemini_key = os.environ.get("GEMINI_API_KEY", "")
    if gemini_key:
        try:
            return generate_hero_image_imagen(episode, gemini_key)
        except Exception as exc:
            print(f"Imagen 3 failed ({exc}). Falling back to Pillow.")
    else:
        print("GEMINI_API_KEY not set. Using Pillow fallback image.")
    return generate_hero_image_pillow(episode)


# ── HTML assembly ─────────────────────────────────────────────────────────────

def build_html(episode, body_html, image_filename):
    slug       = episode["slug"]
    ep_num     = episode["episode"]
    title      = episode["title"]
    og_desc    = episode["og_description"]
    tag        = episode.get("tag", "AI Engineering")
    url        = f"{BASE_URL}/blog/ai-eng-ep{ep_num:02d}-{slug}.html"
    img_url    = (f"{BASE_URL}/images/{image_filename}"
                  if image_filename else f"{BASE_URL}/images/og-default.jpg")
    date_disp  = datetime.date.today().strftime("%-d %b %Y")
    date_iso   = TODAY
    kw_json    = json.dumps(episode.get("keywords", []))
    enc_url    = urllib.parse.quote(url, safe="")
    enc_title  = urllib.parse.quote(title, safe="")
    img_tag    = f"../images/{image_filename}" if image_filename else "../images/og-default.jpg"
    playlist   = os.environ.get("YOUTUBE_AI_SERIES_PLAYLIST_ID", "")
    playlist_link = (
        f'<p class="series-link">This is part of the '
        f'<a href="https://www.youtube.com/playlist?list={playlist}" '
        f'target="_blank" rel="noopener">AI Engineering: Zero to Master</a> series '
        f'on the DAIS YouTube channel.</p>'
        if playlist else
        '<p class="series-link">This is part of the <strong>AI Engineering: Zero to Master</strong> '
        'series on the DAIS YouTube channel. Subscribe to follow every Saturday.</p>'
    )

    share_btns = f"""<div class="blog-share">
  <div class="blog-share-inner">
    <span class="blog-share-label">Share this article</span>
    <div class="blog-share-btns">
      <a href="https://www.facebook.com/sharer/sharer.php?u={enc_url}" class="blog-share-btn blog-share-facebook" target="_blank" rel="noopener noreferrer" aria-label="Share on Facebook"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18 2h-3a5 5 0 00-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 011-1h3z"/></svg><span>Facebook</span></a>
      <a href="https://www.linkedin.com/sharing/share-offsite/?url={enc_url}" class="blog-share-btn blog-share-linkedin" target="_blank" rel="noopener noreferrer" aria-label="Share on LinkedIn"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M16 8a6 6 0 016 6v7h-4v-7a2 2 0 00-2-2 2 2 0 00-2 2v7h-4v-7a6 6 0 016-6z"/><rect x="2" y="9" width="4" height="12"/><circle cx="4" cy="4" r="2"/></svg><span>LinkedIn</span></a>
      <a href="https://twitter.com/intent/tweet?url={enc_url}&text={enc_title}" class="blog-share-btn blog-share-twitter" target="_blank" rel="noopener noreferrer" aria-label="Share on X"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg><span>X</span></a>
      <a href="https://wa.me/?text={enc_title}%20{enc_url}" class="blog-share-btn blog-share-whatsapp" target="_blank" rel="noopener noreferrer" aria-label="Share on WhatsApp"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg><span>WhatsApp</span></a>
      <button type="button" class="blog-share-btn blog-share-copy" onclick="(function(b){{var u='{url}';if(navigator.clipboard){{navigator.clipboard.writeText(u).then(function(){{var s=b.querySelector('span');var o=s.textContent;s.textContent='Copied!';b.classList.add('blog-share-copied');setTimeout(function(){{s.textContent=o;b.classList.remove('blog-share-copied')}},2000)}})}}}})(this)" aria-label="Copy link"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg><span>Copy link</span></button>
    </div>
  </div>
</div>"""

    return f"""<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>{title} | The Data and AI School of London</title>
<meta name="description" content="{og_desc}">
<meta name="robots" content="index, follow">
<link rel="canonical" href="{url}">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://fonts.gstatic.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' https://dais-chat.alifrazkhan92.workers.dev; form-action 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none';">
<meta http-equiv="X-Content-Type-Options" content="nosniff">
<meta name="referrer" content="strict-origin-when-cross-origin">
<meta property="og:type" content="article">
<meta property="og:title" content="{title}">
<meta property="og:description" content="{og_desc}">
<meta property="og:url" content="{url}">
<meta property="og:image" content="{img_url}">
<meta property="og:image:width" content="1792">
<meta property="og:image:height" content="1024">
<meta property="og:site_name" content="The Data and AI School of London">
<meta property="article:published_time" content="{date_iso}">
<meta property="article:author" content="Ali Fraz Khan">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="{title}">
<meta name="twitter:description" content="{og_desc}">
<meta name="twitter:image" content="{img_url}">
<link rel="icon" type="image/svg+xml" href="../images/favicon.svg" />
<link rel="icon" type="image/png" sizes="64x64" href="../images/favicon-64.png" />
<link rel="icon" type="image/png" sizes="32x32" href="../favicon.png" />
<link rel="apple-touch-icon" sizes="180x180" href="../images/apple-touch-icon.png" />
<link rel="stylesheet" href="../css/styles.css" />
<script type="application/ld+json">
{{
  "@context": "https://schema.org",
  "@type": "Article",
  "headline": "{title}",
  "description": "{og_desc}",
  "image": "{img_url}",
  "url": "{url}",
  "datePublished": "{date_iso}",
  "dateModified": "{date_iso}",
  "author": {{"@type": "Organization", "name": "The Data and AI School of London", "url": "{BASE_URL}"}},
  "publisher": {{"@type": "Organization", "name": "The Data and AI School of London", "url": "{BASE_URL}"}},
  "keywords": {kw_json},
  "isPartOf": {{
    "@type": "CreativeWorkSeries",
    "name": "AI Engineering: Zero to Master",
    "url": "{BASE_URL}/blog/"
  }}
}}
</script>
</head>
<body>
<div id="navbar-placeholder"></div>
<script src="../js/navbar.js"></script>

<main class="blog-post-page" id="main-content">
<article class="blog-post-article">

  <div class="blog-post-hero">
    <img src="{img_tag}" alt="{title}" class="blog-post-hero-img" loading="eager" />
  </div>

  <div class="blog-post-content">
    <div class="blog-post-meta">
      <span class="blog-tag">{tag}</span>
      <span class="blog-date">{date_disp}</span>
      <span class="blog-read-time">15 min read</span>
    </div>
    <h1 class="blog-post-title">{title}</h1>

    {playlist_link}

    {body_html}

    {share_btns}
  </div>
</article>
</main>

<div id="footer-placeholder"></div>
<script src="../js/footer.js"></script>
<div id="chatbot-placeholder"></div>
<script src="../js/chatbot.js"></script>
</body>
</html>
"""


# ── Blog listing update ───────────────────────────────────────────────────────

def update_blog_listing(episode, image_filename):
    """Insert the new episode card into blog.html and update blog.html series listing."""
    if not BLOG_LISTING.exists():
        print(f"WARNING: {BLOG_LISTING} not found. Skipping listing update.")
        return

    slug       = episode["slug"]
    ep_num     = episode["episode"]
    title      = episode["title"]
    og_desc    = episode["og_description"]
    tag        = episode.get("tag", "AI Engineering")
    file_name  = f"ai-eng-ep{ep_num:02d}-{slug}.html"
    img_src    = f"images/{image_filename}" if image_filename else "images/og-default.jpg"
    date_disp  = datetime.date.today().strftime("%-d %b %Y")

    new_card = f"""        <article class="blog-card">
          <a href="blog/{file_name}" class="blog-card-img-link" tabindex="-1" aria-hidden="true">
            <img src="{img_src}" alt="{title}" class="blog-card-img" loading="lazy" />
          </a>
          <div class="blog-card-body">
            <div class="blog-card-meta">
              <span class="blog-tag">{tag}</span>
              <span class="blog-date">{date_disp}</span>
            </div>
            <h2 class="blog-card-title">
              <a href="blog/{file_name}">{title}</a>
            </h2>
            <p class="blog-card-excerpt">{og_desc}</p>
            <a href="blog/{file_name}" class="blog-card-read-more">Read article</a>
          </div>
        </article>"""

    content = BLOG_LISTING.read_text(encoding="utf-8")

    # Insert after the blog grid opening tag
    insert_markers = [
        '<div class="blog-grid">',
        '<div id="blog-grid"',
        'class="blog-grid"',
    ]
    for marker in insert_markers:
        if marker in content:
            insert_pos = content.index(marker) + len(marker)
            end_of_tag = content.index(">", insert_pos) + 1
            content = content[:end_of_tag] + "\n" + new_card + content[end_of_tag:]
            BLOG_LISTING.write_text(content, encoding="utf-8")
            print(f"blog.html updated with {file_name}")
            return

    print("WARNING: Could not find blog grid in blog.html")


def update_sitemap(slug, ep_num):
    if not SITEMAP.exists():
        print(f"WARNING: {SITEMAP} not found. Skipping sitemap update.")
        return

    file_name = f"ai-eng-ep{ep_num:02d}-{slug}.html"
    new_url   = f"{BASE_URL}/blog/{file_name}"
    content   = SITEMAP.read_text(encoding="utf-8")

    if new_url in content:
        print("Sitemap already contains this URL.")
        return

    entry = (
        f"\n  <url>\n"
        f"    <loc>{new_url}</loc>\n"
        f"    <lastmod>{TODAY}</lastmod>\n"
        f"    <changefreq>monthly</changefreq>\n"
        f"    <priority>0.7</priority>\n"
        f"  </url>"
    )
    content = content.replace("</urlset>", entry + "\n</urlset>")
    SITEMAP.write_text(content, encoding="utf-8")
    print(f"Sitemap updated with {file_name}")


# ── YouTube playlist ──────────────────────────────────────────────────────────

def ensure_playlist():
    """Return the AI Engineering playlist ID, creating it if needed."""
    playlist_id = os.environ.get("YOUTUBE_AI_SERIES_PLAYLIST_ID", "").strip()
    if playlist_id:
        return playlist_id

    # Try to create it
    rt = os.environ.get("YOUTUBE_REFRESH_TOKEN", "")
    ci = os.environ.get("YOUTUBE_CLIENT_ID", "")
    cs = os.environ.get("YOUTUBE_CLIENT_SECRET", "")
    if not all([rt, ci, cs]):
        return None

    try:
        from google.oauth2.credentials import Credentials
        from google.auth.transport.requests import Request
        from googleapiclient.discovery import build

        creds = Credentials(
            token=None, refresh_token=rt, client_id=ci, client_secret=cs,
            token_uri="https://oauth2.googleapis.com/token",
            scopes=["https://www.googleapis.com/auth/youtube"],
        )
        creds.refresh(Request())
        yt = build("youtube", "v3", credentials=creds)

        resp = yt.playlists().insert(
            part="snippet,status",
            body={
                "snippet": {
                    "title": "AI Engineering: Zero to Master",
                    "description": (
                        "A complete weekly training series from The Data and AI School of London. "
                        "New episode every Saturday. Goes from zero Python knowledge to senior AI engineer level. "
                        "Topics: Python, ML, deep learning, LLMs, RAG, agents, MLOps, deployment and more.\n\n"
                        "Visit: https://www.dataaischool.com"
                    ),
                    "defaultLanguage": "en-GB",
                },
                "status": {"privacyStatus": "public"},
            }
        ).execute()
        pid = resp["id"]
        print(f"\nCreated YouTube playlist: https://www.youtube.com/playlist?list={pid}")
        print(f"IMPORTANT: Save this as GitHub secret YOUTUBE_AI_SERIES_PLAYLIST_ID = {pid}")
        return pid
    except Exception as exc:
        print(f"Could not create playlist: {exc}")
        return None


def add_to_playlist(video_id, playlist_id):
    rt = os.environ.get("YOUTUBE_REFRESH_TOKEN", "")
    ci = os.environ.get("YOUTUBE_CLIENT_ID", "")
    cs = os.environ.get("YOUTUBE_CLIENT_SECRET", "")
    if not all([rt, ci, cs, playlist_id, video_id]):
        return

    try:
        from google.oauth2.credentials import Credentials
        from google.auth.transport.requests import Request
        from googleapiclient.discovery import build

        creds = Credentials(
            token=None, refresh_token=rt, client_id=ci, client_secret=cs,
            token_uri="https://oauth2.googleapis.com/token",
            scopes=["https://www.googleapis.com/auth/youtube"],
        )
        creds.refresh(Request())
        yt = build("youtube", "v3", credentials=creds)
        yt.playlistItems().insert(
            part="snippet",
            body={
                "snippet": {
                    "playlistId": playlist_id,
                    "resourceId": {"kind": "youtube#video", "videoId": video_id},
                }
            }
        ).execute()
        print(f"  Added to playlist: https://www.youtube.com/playlist?list={playlist_id}")
    except Exception as exc:
        print(f"  Could not add to playlist: {exc}")


# ── Video generation via subprocess ──────────────────────────────────────────

def generate_video(blog_file, series_ep):
    """Call generate_blog_video.py with 15-min settings."""
    env = os.environ.copy()
    env["VIDEO_DURATION_MINS"] = "15"

    print(f"\nGenerating 15-min video for {blog_file.name}...")
    result = subprocess.run(
        [sys.executable, str(REPO_ROOT / "scripts" / "generate_blog_video.py"), str(blog_file)],
        env=env,
        cwd=str(REPO_ROOT),
    )
    return result.returncode == 0


# ── Social sharing ────────────────────────────────────────────────────────────

def share_social(blog_file_name):
    """Share via social_share.py using the new blog file."""
    env = os.environ.copy()
    env["NEW_FILES"] = f"blog/{blog_file_name}"
    result = subprocess.run(
        [sys.executable, str(REPO_ROOT / "scripts" / "social_share.py")],
        env=env,
        cwd=str(REPO_ROOT),
    )
    return result.returncode == 0


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    anthropic_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not anthropic_key:
        print("ANTHROPIC_API_KEY not set. Cannot generate blog content.")
        sys.exit(1)

    # Load curriculum and determine current episode
    curriculum = load_curriculum()
    episodes   = curriculum["episodes"]
    ep_num     = current_episode_number()

    if ep_num >= len(episodes):
        print(f"All {len(episodes)} episodes have been published. Series complete.")
        return

    episode  = episodes[ep_num]
    ep_title = episode["title"]
    slug     = episode["slug"]
    fname    = blog_filename(episode)
    out_path = BLOG_DIR / fname

    print(f"\n{'='*60}")
    print(f"AI Engineering Series: Episode {ep_num}")
    print(f"Title: {ep_title}")
    print(f"Output: {fname}")
    print(f"{'='*60}\n")

    # Generate blog post body
    print("Generating blog content with Claude...")
    body_html = generate_blog_content(episode, anthropic_key)
    print(f"Content generated: {len(body_html)} chars")

    # Generate hero image
    print("Generating hero image...")
    image_filename = generate_hero_image(episode)

    # Ensure playlist exists (creates it on first run)
    print("Ensuring YouTube playlist exists...")
    playlist_id = ensure_playlist()

    # Write blog HTML
    html = build_html(episode, body_html, image_filename)
    out_path.write_text(html, encoding="utf-8")
    print(f"Blog written: {out_path}")

    # Update listings
    update_blog_listing(episode, image_filename)
    update_sitemap(slug, ep_num)

    # Generate 15-minute video + upload to YouTube
    print("\nGenerating and uploading 15-minute video...")
    video_ok = generate_video(out_path, episode)

    # Add to playlist if we know the video ID (generate_blog_video.py prints it)
    # Playlist addition is best-effort; the video is already uploaded
    if playlist_id and video_ok:
        print("(Playlist addition handled by generate_blog_video.py output above)")

    # Share on social media
    print("\nSharing on social media...")
    share_social(fname)

    print(f"\nEpisode {ep_num} complete: {ep_title}")
    print(f"Blog: {BASE_URL}/blog/{fname}")


if __name__ == "__main__":
    main()
