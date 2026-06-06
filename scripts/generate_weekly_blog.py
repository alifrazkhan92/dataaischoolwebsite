#!/usr/bin/env python3
"""
DAIS Weekly Blog Generator
Generates a new SEO-optimised blog post each week using the Anthropic API,
creates a branded header image, updates the sitemap, and saves the HTML file.
The existing social-share.yml workflow detects the new blog/*.html file
and automatically posts to Facebook, Instagram, and LinkedIn.

Required GitHub secrets:
  ANTHROPIC_API_KEY
"""

import os
import sys
import json
import math
import textwrap
import datetime
import re
import urllib.request
import urllib.parse

try:
    from PIL import Image, ImageDraw, ImageFont
    PIL_AVAILABLE = True
except ImportError:
    PIL_AVAILABLE = False
    print("WARNING: Pillow not installed. Image generation will be skipped.")


# ---------------------------------------------------------------------------
# Topic rotation list. Each week picks the next unused topic.
# Add new topics here. The script tracks which have been used via
# blog/BLOG_TOPICS_USED.json (committed to the repo).
# ---------------------------------------------------------------------------
TOPIC_QUEUE = [
    {
        "slug": "how-to-become-data-scientist-uk-2026",
        "title": "How to Become a Data Scientist in the UK: The 2026 Complete Guide",
        "tag": "Career Guide",
        "og_description": "A step-by-step guide to starting or switching to a data science career in the UK in 2026, with salary data, qualification routes, and expert advice.",
        "keywords": ["how to become a data scientist UK", "data scientist career UK 2026", "data science qualification UK", "Ofqual data science UK"],
        "angle": "Comprehensive UK-specific career guide for aspiring data scientists in 2026. Cover: what data scientists do, UK salary ranges by seniority, required skills (Python, SQL, ML, statistics), the difference between regulated qualifications and bootcamp certificates, step-by-step 12-month plan, and links to DAIS courses."
    },
    {
        "slug": "ofqual-vs-unregulated-data-science-certificate-uk",
        "title": "Ofqual Regulated vs Unregulated: Does Your Data Science Certificate Matter to UK Employers?",
        "tag": "Qualifications",
        "og_description": "UK employers are increasingly distinguishing between regulated and unregulated data qualifications. Find out what the difference means for your career.",
        "keywords": ["Ofqual data science UK", "regulated data science qualification", "NCFE data qualification", "RQF level 4 data science", "bootcamp certificate vs diploma UK"],
        "angle": "Explain the RQF and Ofqual framework in plain English. Compare regulated qualifications vs bootcamp certificates and MOOC completions. Show how employers, universities, and apprenticeship frameworks treat each differently. Make the case for DAIS NCFE qualifications without being salesy."
    },
    {
        "slug": "data-science-salary-uk-2026-by-role",
        "title": "Data Science Salaries in the UK: What You Can Expect in 2026 by Role and City",
        "tag": "Salaries and Jobs",
        "og_description": "Up-to-date UK data science salary figures for 2026, broken down by role, experience level, and city, with advice on how to increase your earning potential.",
        "keywords": ["data science salary UK 2026", "data analyst salary UK", "ML engineer salary UK", "data scientist London salary", "data science pay UK"],
        "angle": "Present realistic UK salary data for data analyst, data scientist, ML engineer, data engineer, and AI product manager roles in 2026. Break down by experience level (junior/mid/senior) and by city (London, Manchester, Edinburgh, Leeds, Bristol). Discuss what drives salary growth and how qualifications factor in."
    },
    {
        "slug": "career-change-data-science-uk-30s-40s",
        "title": "Changing Career to Data Science in the UK at 30, 40, or Beyond: An Honest Guide",
        "tag": "Career Change",
        "og_description": "Is it realistic to switch to data science after 30 or 40 in the UK? This guide covers what to expect, how long it takes, and which routes actually work.",
        "keywords": ["career change data science UK", "data science over 30 UK", "switch career data scientist UK", "data science without degree UK", "adult learner data science UK"],
        "angle": "Honest, warm, and practical guide for mid-career professionals considering a switch to data. Address common fears (too old, no maths background, too expensive). Share what skills transfer from other industries. Discuss realistic timescales. Explain how DAIS portfolio-based qualifications suit people who cannot sit formal exams."
    },
    {
        "slug": "cloud-data-engineering-career-uk",
        "title": "Cloud Data Engineering: The UK Career No One Is Talking About (But Should Be)",
        "tag": "Cloud Careers",
        "og_description": "Cloud data engineers are among the highest-paid and most in-demand professionals in the UK tech sector. Find out what they do and how to become one.",
        "keywords": ["cloud data engineer UK", "data engineering career UK", "Azure data engineer qualification", "cloud engineering UK salary", "data pipeline engineer UK"],
        "angle": "Introduce cloud data engineering as a career: what data engineers build, the difference between data engineers and data scientists, UK demand and salary data, key skills (Azure, dbt, Spark, Airflow, Python), and how to get started with DAIS Cloud qualifications."
    },
    {
        "slug": "study-data-science-while-working-full-time-uk",
        "title": "How to Study Data Science While Working Full Time in the UK",
        "tag": "Study Tips",
        "og_description": "Practical strategies for learning data science around a full-time job in the UK, from managing time to choosing the right qualification route.",
        "keywords": ["study data science while working UK", "part time data science course UK", "online data science qualification UK", "data science evening study UK", "flexible data science learning UK"],
        "angle": "Practical, encouraging guide for working adults. Cover: how much time per week is realistic, how to structure a study week, tools that help (spaced repetition, project-based learning), why portfolio-based assessment suits working professionals, and why no-exam qualifications like those at DAIS are designed for this context."
    },
    {
        "slug": "what-is-ncfe-qualification-uk-employers",
        "title": "What Is an NCFE Qualification and Do UK Employers Recognise It?",
        "tag": "Qualifications",
        "og_description": "NCFE is one of the UK's oldest awarding bodies. Find out what NCFE qualifications are, how they are regulated, and whether employers value them.",
        "keywords": ["NCFE qualification UK", "what is NCFE", "NCFE recognized UK employers", "NCFE Ofqual", "NCFE data science"],
        "angle": "Explain NCFE's history and regulatory status (Ofqual-regulated, recognised on the RQF). Cover: what types of qualifications NCFE offers, how employers view them vs degrees and bootcamp certificates, university progression options, and how DAIS delivers NCFE qualifications in Data and AI."
    },
    {
        "slug": "ai-tools-for-data-analysts-uk-2026",
        "title": "The AI Tools Every UK Data Analyst Should Be Using in 2026",
        "tag": "AI Tools",
        "og_description": "From GitHub Copilot to Claude and ChatGPT, these AI tools are transforming how UK data analysts work. Here is what to use and how.",
        "keywords": ["AI tools for data analysts UK", "GitHub Copilot data science", "ChatGPT data analysis", "best AI tools data analyst 2026", "AI-augmented data science"],
        "angle": "Practical tool guide covering: GitHub Copilot for coding, Claude/ChatGPT for EDA and analysis assistance, Julius AI, NotebookLM, and purpose-built data AI tools. For each: what it does well, limitations, and how to use it responsibly alongside proper statistical thinking. Link to DAIS AI qualifications."
    },
]


BASE_URL = "https://www.dataaischool.com"
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BLOG_DIR = os.path.join(REPO_ROOT, "blog")
IMAGES_DIR = os.path.join(REPO_ROOT, "images")
SITEMAP_PATH = os.path.join(REPO_ROOT, "sitemap.xml")
TOPICS_USED_PATH = os.path.join(BLOG_DIR, "BLOG_TOPICS_USED.json")

TODAY = datetime.date.today().isoformat()


# ---------------------------------------------------------------------------
# Topic selection
# ---------------------------------------------------------------------------
def pick_topic():
    """Return the next unused topic from TOPIC_QUEUE."""
    used = []
    if os.path.exists(TOPICS_USED_PATH):
        with open(TOPICS_USED_PATH) as f:
            used = json.load(f)
    used_slugs = {t["slug"] for t in used} if used and isinstance(used[0], dict) else set(used)
    for topic in TOPIC_QUEUE:
        if topic["slug"] not in used_slugs:
            return topic
    # All used: reset rotation
    print("All topics used. Resetting rotation.")
    return TOPIC_QUEUE[0]


def mark_topic_used(topic):
    """Record topic slug as used."""
    used = []
    if os.path.exists(TOPICS_USED_PATH):
        with open(TOPICS_USED_PATH) as f:
            used = json.load(f)
    if not used or not isinstance(used[0], dict):
        used = [{"slug": s} for s in used]
    if not any(t["slug"] == topic["slug"] for t in used):
        used.append({"slug": topic["slug"], "published": TODAY})
    with open(TOPICS_USED_PATH, "w") as f:
        json.dump(used, f, indent=2)


# ---------------------------------------------------------------------------
# Blog content generation via Anthropic API
# ---------------------------------------------------------------------------
def generate_blog_content(topic):
    """Call Anthropic API to write the blog post body HTML."""
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        raise RuntimeError("ANTHROPIC_API_KEY not set")

    prompt = f"""You are Ali Fraz Khan, FHEA, CEO and Principal of The Data and AI School of London (DAIS),
a UK online specialist school delivering Ofqual-regulated NCFE qualifications in Data Science, AI, Cloud Engineering,
and Cyber Security at RQF Levels 3 to 5. You are writing a blog post for www.dataaischool.com.

MANDATORY RULES:
- Write in British English throughout. Use "programme", "recognised", "analyse", "organisation", etc.
- NEVER use em dashes (--) or en dashes. Use commas, colons, or short hyphens only.
- Tone: professional, authoritative, warm, and direct. No filler phrases.
- Write for working UK professionals considering upskilling, not students.
- Every article must include internal links to at least two of these existing DAIS blog posts,
  using their exact filenames (link as relative paths):
    - what-is-data-science-uk-guide.html
    - what-is-agentic-ai-explained.html
    - why-everyone-needs-to-learn-ai-implementation.html
    - getting-started-with-python-for-data-science.html
    - will-ai-replace-data-scientists-uk-2026.html
- Include at least one CTA linking to ../courses.html or ../apply.html
- Do NOT use markdown. Write only clean HTML for the blog body (no <html>, <head>, or <body> tags).
- Structure: h2 and h3 headings, p tags, ul/ol lists, one table (use inline style for borders),
  one blockquote, and a CTA div at the end.
- Minimum 1,200 words of actual content.
- Be specific and practical. Cite UK-specific facts, salary figures, employer trends, and regulatory context.
- Do not mention "Data SciKit AI Ltd" anywhere.
- Make it genuinely useful and shareable on LinkedIn.

TOPIC: {topic['title']}

WRITING ANGLE: {topic['angle']}

KEYWORDS TO INCLUDE NATURALLY (not keyword-stuffed):
{', '.join(topic['keywords'])}

Write only the blog body HTML content, starting with a <p> tag and ending after the CTA div."""

    payload = json.dumps({
        "model": "claude-haiku-4-5",
        "max_tokens": 4000,
        "messages": [{"role": "user", "content": prompt}]
    }).encode()

    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=payload,
        headers={
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        method="POST"
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        data = json.load(resp)
    return data["content"][0]["text"]


# ---------------------------------------------------------------------------
# Image generation
# ---------------------------------------------------------------------------
def generate_hero_image(topic):
    """Generate a branded blog hero image (1200x630) and return the filename."""
    if not PIL_AVAILABLE:
        return None

    slug = topic["slug"]
    fname = f"blog-{slug}.png"
    out_path = os.path.join(IMAGES_DIR, fname)

    W, H = 1200, 630
    img = Image.new("RGB", (W, H), (8, 20, 60))
    draw = ImageDraw.Draw(img)

    # Background gradient
    for y in range(H):
        t = y / H
        draw.line([(0, y), (W, y)], fill=(int(8 + t*15), int(20 + t*25), int(60 + t*20)))

    # Subtle grid
    for x in range(0, W, 60):
        draw.line([(x, 0), (x, H)], fill=(16, 38, 85))
    for y in range(0, H, 60):
        draw.line([(0, y), (W, y)], fill=(16, 38, 85))

    # Warm glow (bottom-left, humanising)
    for i in range(80, 0, -8):
        draw.ellipse([-40 + i*2, H - 180 - i, 260 + i, H + 40 + i],
                     outline=(min(255, 160 + i), min(130, 80 + i//3), 20))

    # Blue tech glow (top-right)
    for i in range(60, 0, -6):
        draw.ellipse([W - 200 - i*2, -60 - i, W + 30 + i, 180 + i*2],
                     outline=(30 + i//4, 100 + i//3, 210))

    # Neural network nodes (right half)
    import random
    random.seed(42)
    nodes = [(680 + random.randint(-30,30)*2, 50 + random.randint(0,12)*25) for _ in range(12)]
    for i in range(len(nodes)):
        for j in range(i+1, min(i+3, len(nodes))):
            draw.line([nodes[i][0], nodes[i][1], nodes[j][0], nodes[j][1]], fill=(28, 72, 155), width=1)
    for nx, ny in nodes:
        draw.ellipse([nx-6, ny-6, nx+6, ny+6], fill=(40, 110, 220))
        draw.ellipse([nx-3, ny-3, nx+3, ny+3], fill=(110, 175, 255))

    # Person silhouette (left side)
    draw.ellipse([65, 175, 150, 260], fill=(195, 150, 105))
    draw.ellipse([62, 162, 153, 222], fill=(40, 25, 8))
    draw.rectangle([93, 258, 118, 292], fill=(185, 138, 93))
    draw.rounded_rectangle([28, 290, 185, 445], radius=20, fill=(28, 48, 105))
    draw.rounded_rectangle([155, 305, 198, 418], radius=12, fill=(28, 48, 105))
    draw.rounded_rectangle([20, 305, 62, 418], radius=12, fill=(28, 48, 105))
    draw.ellipse([152, 408, 205, 448], fill=(195, 150, 105))
    draw.ellipse([18, 408, 62, 448], fill=(195, 150, 105))

    # Laptop
    draw.rounded_rectangle([52, 445, 380, 522], radius=10, fill=(22, 32, 58))
    draw.rounded_rectangle([58, 450, 375, 518], radius=8, fill=(28, 42, 78))
    for ky in range(460, 510, 11):
        for kx in range(68, 365, 26):
            draw.rounded_rectangle([kx, ky, kx+20, ky+8], radius=2, fill=(38, 58, 100))
    draw.rounded_rectangle([58, 278, 370, 442], radius=12, fill=(12, 20, 42))
    draw.rounded_rectangle([64, 284, 364, 438], radius=10, fill=(8, 16, 36))

    # Code on screen
    try:
        fc = ImageFont.truetype("/System/Library/Fonts/Menlo.ttc", 11)
    except Exception:
        fc = ImageFont.load_default()
    code = ["import anthropic", "client = anthropic.Anthropic()", "# Generating weekly blog post...", "response = client.messages.create(", "  model='claude-haiku-4-5')"]
    for idx, line in enumerate(code):
        col = (90, 210, 130) if idx < 2 else (160, 160, 255) if idx == 2 else (100, 190, 140)
        draw.text((70, 292 + idx*22), line[:40], fill=col, font=fc)

    # Gold divider
    draw.rectangle([415, 195, 420, 528], fill=(215, 162, 35))

    # Main text
    try:
        fbold = ImageFont.truetype("/System/Library/Fonts/Helvetica-Bold.ttc", 46)
        fbold_sm = ImageFont.truetype("/System/Library/Fonts/Helvetica-Bold.ttc", 36)
        fsub = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 18)
        ftag = ImageFont.truetype("/System/Library/Fonts/Helvetica-Bold.ttc", 14)
        fbrand = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 14)
    except Exception:
        fbold = fbold_sm = fsub = ftag = fbrand = ImageFont.load_default()

    # Tag
    tag_text = topic["tag"].upper()
    draw.rounded_rectangle([432, 168, 432 + len(tag_text)*9 + 20, 194], radius=11, fill=(170, 120, 15))
    draw.text((442, 173), tag_text + "   2026", fill=(255, 240, 195), font=ftag)

    # Headline (wrap at 22 chars per line)
    title = topic["title"]
    words = title.split()
    lines = []
    cur = ""
    for w in words:
        test = (cur + " " + w).strip()
        if len(test) > 22 and cur:
            lines.append(cur)
            cur = w
        else:
            cur = test
    if cur:
        lines.append(cur)

    colors = [(255,255,255), (95,195,255), (255,255,255), (210,210,210)]
    for i, line in enumerate(lines[:4]):
        y_pos = 208 + i * 62
        font = fbold if i < 2 else fbold_sm
        col = colors[i % len(colors)]
        draw.text((432, y_pos), line, fill=col, font=font)

    # Subtext
    sub = topic["og_description"][:80]
    sub_lines = textwrap.wrap(sub, width=42)
    for i, sl in enumerate(sub_lines[:3]):
        draw.text((432, 430 + i * 26), sl, fill=(185, 185, 185), font=fsub)

    # Branding bar
    draw.rectangle([0, 582, W, 630], fill=(10, 24, 68))
    draw.rectangle([0, 580, W, 584], fill=(215, 162, 35))
    draw.text((28, 598), "The Data and AI School of London", fill=(215, 162, 35), font=fbrand)
    draw.text((W - 242, 598), "www.dataaischool.com", fill=(155, 175, 215), font=fbrand)

    img.save(out_path, "PNG")
    print(f"Image saved: {fname} ({os.path.getsize(out_path)//1024}KB)")
    return fname


# ---------------------------------------------------------------------------
# HTML assembly
# ---------------------------------------------------------------------------
def build_html(topic, body_html, image_filename):
    slug = topic["slug"]
    title = topic["title"]
    og_desc = topic["og_description"]
    tag = topic["tag"]
    url = f"{BASE_URL}/blog/{slug}.html"
    img_url = f"{BASE_URL}/images/{image_filename}" if image_filename else f"{BASE_URL}/images/og-default.jpg"
    date_display = datetime.date.today().strftime("%-d %b %Y")
    date_iso = TODAY
    keywords_json = json.dumps(topic["keywords"])
    enc_url = urllib.parse.quote(url, safe="")
    enc_title = urllib.parse.quote(title, safe="")

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
 <title>{title} | DAIS London</title>
 <meta name="description" content="{og_desc}">
 <meta name="robots" content="index, follow">
 <link rel="canonical" href="{url}">
 <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://fonts.gstatic.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none';">
 <meta http-equiv="X-Content-Type-Options" content="nosniff">
 <meta property="og:type" content="article">
 <meta property="og:title" content="{title}">
 <meta property="og:description" content="{og_desc}">
 <meta property="og:url" content="{url}">
 <meta property="og:image" content="{img_url}">
 <meta property="og:image:width" content="1200">
 <meta property="og:image:height" content="630">
 <meta property="og:site_name" content="The Data and AI School of London">
 <meta property="article:published_time" content="{date_iso}">
 <meta property="article:author" content="Ali Fraz Khan">
 <meta name="twitter:card" content="summary_large_image">
 <meta name="twitter:title" content="{title}">
 <meta name="twitter:description" content="{og_desc}">
 <meta name="twitter:image" content="{img_url}">
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
   "datePublished": "{date_iso}",
   "dateModified": "{date_iso}",
   "author": [{{
     "@type": "Person",
     "name": "Ali Fraz Khan",
     "honorificSuffix": "FHEA",
     "jobTitle": "CEO and Principal",
     "worksFor": {{"@type": "Organization", "name": "The Data and AI School of London"}}
   }}],
   "publisher": {{
     "@type": "EducationalOrganization",
     "@id": "{BASE_URL}/#organisation",
     "name": "The Data and AI School of London",
     "logo": {{"@type": "ImageObject", "url": "{BASE_URL}/favicon.png"}}
   }},
   "mainEntityOfPage": "{url}",
   "keywords": {keywords_json},
   "breadcrumb": {{
     "@type": "BreadcrumbList",
     "itemListElement": [
       {{"@type": "ListItem", "position": 1, "name": "Home", "item": "{BASE_URL}/"}},
       {{"@type": "ListItem", "position": 2, "name": "Blog", "item": "{BASE_URL}/blog.html"}},
       {{"@type": "ListItem", "position": 3, "name": "{title}", "item": "{url}"}}
     ]
   }}
 }}
 </script>
 </head>
 <body>
 <header class="site-header">
   <div class="header-inner">
     <a href="../index.html" class="logo">
       <img src="../images/logo-dais.png" alt="DAIS" class="logo-img">
       <span class="logo-text">
         <span class="logo-name">The Data and AI School</span>
         <span class="logo-location">of London</span>
       </span>
     </a>
     <button type="button" class="menu-toggle" aria-expanded="false" aria-controls="nav-main">Menu</button>
     <nav id="nav-main">
       <ul class="nav-main">
         <li><a href="../index.html">Home</a></li>
         <li><a href="../about.html">About</a></li>
         <li><a href="../courses.html">Courses</a></li>
         <li><a href="../blog.html" aria-current="page">Blog</a></li>
         <li><a href="../apply.html">Apply</a></li>
         <li><a href="../contact.html">Contact</a></li>
         <li class="nav-portal-item"><a href="https://learn.dataaischool.com" class="nav-portal-btn" target="_blank" rel="noopener noreferrer">&#127891; Student Portal</a></li>
         <li class="nav-theme-wrap">
           <button type="button" class="theme-toggle" aria-label="Theme: light" title="Toggle theme">
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

 <main>
   <article class="blog-post">
     <nav aria-label="Breadcrumb" style="margin-bottom:1.5rem;font-size:0.875rem;color:var(--text-muted)">
       <a href="../index.html">Home</a> &rsaquo; <a href="../blog.html">Blog</a> &rsaquo; <span>{title}</span>
     </nav>

     <header class="blog-post-header">
       <div class="blog-card-meta">
         <span class="blog-tag">{tag}</span>
         <time class="blog-date" datetime="{date_iso}">{date_display}</time>
         <span class="blog-read-time">10 min read</span>
       </div>
       <h1>{title}</h1>
       <div class="blog-post-meta">
         <span class="blog-author">By <strong>Ali Fraz Khan, FHEA</strong>, CEO &amp; Principal, The Data and AI School of London</span>
       </div>
       <img
         src="../images/{image_filename if image_filename else 'og-default.jpg'}"
         alt="{title}"
         width="1200"
         height="630"
         style="width:100%;height:auto;border-radius:var(--radius-lg);margin-bottom:1.5rem;"
         loading="eager"
       />
     </header>

     {share_btns}

     <div class="blog-post-body">
       {body_html}
     </div>

     {share_btns.replace('Share this article', 'Found this useful? Share it')}

   </article>
 </main>

 <footer class="site-footer">
   <div class="footer-inner">
     <div class="footer-brand">
       <a href="../index.html" class="logo" style="margin-bottom:0.5rem;">
         <img src="../images/logo-dais.png" alt="DAIS" class="logo-img" style="height:36px;">
         <span class="logo-text">
           <span class="logo-name">The Data and AI School</span>
           <span class="logo-location">of London</span>
         </span>
       </a>
       <p class="footer-tagline">Ofqual-regulated qualifications in Data, AI and Technology. Delivered entirely online.</p>
     </div>
     <nav class="footer-nav" aria-label="Footer navigation">
       <ul>
         <li><a href="../index.html">Home</a></li>
         <li><a href="../about.html">About</a></li>
         <li><a href="../courses.html">Courses</a></li>
         <li><a href="../blog.html">Blog</a></li>
         <li><a href="../apply.html">Apply</a></li>
         <li><a href="../contact.html">Contact</a></li>
         <li><a href="../privacy-policy.html">Privacy Policy</a></li>
       </ul>
     </nav>
   </div>
   <div class="footer-bottom">
     <p>&copy; {datetime.date.today().year} The Data and AI School of London. NCFE approved centre. Qualifications regulated by Ofqual.</p>
   </div>
 </footer>

 <script src="../js/navbar.js"></script>
 <script src="../js/theme.js" defer></script>
 </body>
</html>"""


# ---------------------------------------------------------------------------
# Sitemap update
# ---------------------------------------------------------------------------
def update_sitemap(slug):
    url_entry = f"""  <url>
    <loc>{BASE_URL}/blog/{slug}.html</loc>
    <lastmod>{TODAY}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.9</priority>
  </url>
"""
    with open(SITEMAP_PATH) as f:
        content = f.read()
    if f"{slug}.html" in content:
        print("Sitemap already contains this slug. Skipping.")
        return
    content = content.replace("</urlset>", url_entry + "</urlset>")
    with open(SITEMAP_PATH, "w") as f:
        f.write(content)
    print("Sitemap updated.")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    print(f"DAIS Weekly Blog Generator - {TODAY}")

    topic = pick_topic()
    print(f"Selected topic: {topic['title']}")

    slug = topic["slug"]
    html_path = os.path.join(BLOG_DIR, f"{slug}.html")

    if os.path.exists(html_path):
        print(f"Blog post already exists: {html_path}. Skipping.")
        sys.exit(0)

    # Generate image
    print("Generating hero image...")
    img_file = generate_hero_image(topic)

    # Generate blog content
    print("Generating blog content via Anthropic API...")
    body_html = generate_blog_content(topic)

    # Assemble and write HTML
    print("Assembling HTML...")
    html = build_html(topic, body_html, img_file)
    with open(html_path, "w", encoding="utf-8") as f:
        f.write(html)
    print(f"Blog post written: {html_path}")

    # Update sitemap
    update_sitemap(slug)

    # Mark topic used
    mark_topic_used(topic)

    print("Done.")


if __name__ == "__main__":
    main()
