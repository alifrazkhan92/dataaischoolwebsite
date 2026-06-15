#!/usr/bin/env python3
"""
DAIS Blog Video Generator
=========================
Converts a blog post HTML into a narrated slide video and uploads it to YouTube.

Environment variables required:
  ANTHROPIC_API_KEY      — Claude API for script writing
  ELEVENLABS_API_KEY     — ElevenLabs TTS for voiceover
  ELEVENLABS_VOICE_ID    — ElevenLabs voice (default: Adam)
  YOUTUBE_CLIENT_ID      — Google OAuth client ID
  YOUTUBE_CLIENT_SECRET  — Google OAuth client secret
  YOUTUBE_REFRESH_TOKEN  — Refresh token from youtube_auth.py (one-time setup)
  NEW_FILES              — Fallback: space-separated list of blog/*.html paths

Usage:
  python scripts/generate_blog_video.py blog/my-post.html
  python scripts/generate_blog_video.py   # reads NEW_FILES env var
"""

import os
import sys
import json
import re
import shutil
import subprocess
import requests
from pathlib import Path
from bs4 import BeautifulSoup
from PIL import Image, ImageDraw, ImageFont

# ── Constants ─────────────────────────────────────────────────────────────────

SLIDE_W, SLIDE_H = 1920, 1080
NAVY      = (10, 34, 64)       # #0A2240
GOLD      = (232, 160, 32)     # #E8A020
WHITE     = (255, 255, 255)
PALE_BLUE = (160, 190, 225)
BASE_URL  = "https://www.dataaischool.com"

# Font search paths: GitHub Actions (Ubuntu) and macOS
_BOLD_FONTS = [
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
]
_REG_FONTS = [
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
]

YT_DESC = (
    "{description}\n\n"
    "Read the full article: {url}\n\n"
    "The Data and AI School of London (DAIS) offers Ofqual-regulated qualifications "
    "in Data Science, AI and Python. We help UK professionals build career-ready skills.\n\n"
    "Visit: https://www.dataaischool.com\n"
    "Apply: https://www.dataaischool.com/apply.html\n\n"
    "#DataScience #AI #MachineLearning #DAIS #London #NCFE #Ofqual "
    "#UKEducation #ArtificialIntelligence #CareerAdvice"
)


# ── Font + drawing helpers ────────────────────────────────────────────────────

def _font(size, bold=False):
    candidates = _BOLD_FONTS if bold else _REG_FONTS
    for path in candidates:
        if Path(path).exists():
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                continue
    return ImageFont.load_default()


def _wrap(draw, text, font, max_w):
    words = text.split()
    lines, cur = [], ""
    for word in words:
        candidate = (cur + " " + word).strip()
        if draw.textlength(candidate, font=font) <= max_w:
            cur = candidate
        else:
            if cur:
                lines.append(cur)
            cur = word
    if cur:
        lines.append(cur)
    return lines


def _draw_wrapped(draw, text, font, x, y, max_w, fill, leading=None):
    lines = _wrap(draw, text, font, max_w)
    bb    = draw.textbbox((0, 0), "Ag", font=font)
    lh    = leading or (bb[3] - bb[1] + 10)
    for line in lines:
        draw.text((x, y), line, font=font, fill=fill)
        y += lh
    return y


def _paste_logo(canvas, logo, x, y):
    if logo is None:
        return
    if logo.mode == "RGBA":
        canvas.paste(logo, (x, y), mask=logo.split()[3])
    else:
        canvas.paste(logo, (x, y))


def _load_logo(target_h=65):
    path = Path("images/logo-dais.png")
    if not path.exists():
        return None
    try:
        img = Image.open(path).convert("RGBA")
        w   = int(img.width * target_h / img.height)
        return img.resize((w, target_h), Image.LANCZOS)
    except Exception:
        return None


# ── Slide creators ────────────────────────────────────────────────────────────

def slide_title(title, hero_path, out_path):
    """Slide 1: hero image background with title text overlay at bottom."""
    img = Image.new("RGB", (SLIDE_W, SLIDE_H), NAVY)

    # Attempt to use Imagen 3 hero image as background
    if hero_path:
        hp = Path(hero_path)
        if hp.exists():
            try:
                hero  = Image.open(hp).convert("RGB")
                scale = max(SLIDE_W / hero.width, SLIDE_H / hero.height)
                nw    = int(hero.width * scale)
                nh    = int(hero.height * scale)
                hero  = hero.resize((nw, nh), Image.LANCZOS)
                ox    = (nw - SLIDE_W) // 2
                oy    = (nh - SLIDE_H) // 2
                img.paste(hero.crop((ox, oy, ox + SLIDE_W, oy + SLIDE_H)))
            except Exception:
                pass

    # Dark gradient overlay on bottom two-thirds so text is readable
    overlay = Image.new("RGBA", (SLIDE_W, SLIDE_H), (0, 0, 0, 0))
    od = ImageDraw.Draw(overlay)
    start = SLIDE_H // 3
    for y in range(start, SLIDE_H):
        alpha = min(240, int(255 * (y - start) / (SLIDE_H - start)))
        od.line([(0, y), (SLIDE_W, y)], fill=(*NAVY, alpha))
    img = Image.alpha_composite(img.convert("RGBA"), overlay).convert("RGB")
    draw = ImageDraw.Draw(img)

    # DAIS logo + channel label top-left
    logo = _load_logo(68)
    if logo:
        _paste_logo(img, logo, 50, 34)
    draw.text((145, 48), "The Data and AI School of London", font=_font(28), fill=PALE_BLUE)

    # Title at bottom
    margin  = 80
    f_title = _font(64, bold=True)
    lines   = _wrap(draw, title, f_title, SLIDE_W - margin * 2)
    lh      = 78
    y       = SLIDE_H - len(lines) * lh - 120
    for line in lines:
        draw.text((margin, y), line, font=f_title, fill=WHITE)
        y += lh

    # Gold accent underline
    draw.rectangle([(margin, y + 12), (margin + min(480, SLIDE_W // 2), y + 18)], fill=GOLD)

    img.save(out_path)
    print(f"  Title slide created.")


def slide_content(heading, bullets, num, total, out_path):
    """Content slide: navy background, gold heading, bullet points."""
    img  = Image.new("RGB", (SLIDE_W, SLIDE_H), NAVY)
    draw = ImageDraw.Draw(img)

    # Subtle background grid for visual depth
    for x in range(0, SLIDE_W, 140):
        draw.line([(x, 0), (x, SLIDE_H)], fill=(14, 42, 78), width=1)
    for y in range(0, SLIDE_H, 140):
        draw.line([(0, y), (SLIDE_W, y)], fill=(14, 42, 78), width=1)

    # Gold top bar with channel label
    draw.rectangle([(0, 0), (SLIDE_W, 48)], fill=GOLD)
    draw.text((55, 11), "The Data and AI School of London", font=_font(26), fill=NAVY)

    margin = 80
    y = 84

    # Section heading in gold
    f_h = _font(52, bold=True)
    y = _draw_wrapped(draw, heading, f_h, margin, y, SLIDE_W - margin * 2, GOLD, leading=62)
    y += 14

    # Gold divider
    draw.rectangle([(margin, y), (margin + 260, y + 4)], fill=GOLD)
    y += 28

    # Bullet points
    f_b    = _font(38)
    dot_r  = 8
    bx     = margin + 34
    max_bw = SLIDE_W - bx - 100

    for bullet in bullets[:6]:
        # Gold dot marker
        draw.ellipse([(margin, y + 11), (margin + dot_r * 2, y + 11 + dot_r * 2)], fill=GOLD)
        y = _draw_wrapped(draw, bullet, f_b, bx, y, max_bw, WHITE, leading=50)
        y += 12

    # Logo bottom-right
    logo = _load_logo(50)
    if logo:
        _paste_logo(img, logo, SLIDE_W - logo.width - 50, SLIDE_H - logo.height - 38)

    # Slide counter bottom-left
    draw.text((margin, SLIDE_H - 55), f"{num} / {total}", font=_font(28), fill=PALE_BLUE)

    img.save(out_path)


def slide_cta(out_path):
    """Final call-to-action slide."""
    img  = Image.new("RGB", (SLIDE_W, SLIDE_H), NAVY)
    draw = ImageDraw.Draw(img)

    # Subtle background grid
    for x in range(0, SLIDE_W, 140):
        draw.line([(x, 0), (x, SLIDE_H)], fill=(14, 42, 78), width=1)
    for y in range(0, SLIDE_H, 140):
        draw.line([(0, y), (SLIDE_W, y)], fill=(14, 42, 78), width=1)

    # Gold top bar
    draw.rectangle([(0, 0), (SLIDE_W, 48)], fill=GOLD)
    draw.text((55, 11), "The Data and AI School of London", font=_font(26), fill=NAVY)

    cx, cy = SLIDE_W // 2, SLIDE_H // 2

    # Large DAIS logo centred
    logo = _load_logo(130)
    if logo:
        _paste_logo(img, logo, cx - logo.width // 2, cy - 145)

    # Gold divider
    draw.rectangle([(cx - 220, cy + 18), (cx + 220, cy + 23)], fill=GOLD)

    # CTA lines
    lines_cfg = [
        ("New articles every Monday",              _font(38),            PALE_BLUE, cy + 40),
        ("www.dataaischool.com",                   _font(46, bold=True), GOLD,      cy + 95),
        ("Subscribe for weekly AI career insights", _font(34),           WHITE,     cy + 155),
    ]
    for text, font, colour, ty in lines_cfg:
        tw = draw.textlength(text, font=font)
        draw.text((cx - int(tw) // 2, ty), text, font=font, fill=colour)

    img.save(out_path)
    print("  CTA slide created.")


# ── ElevenLabs TTS ────────────────────────────────────────────────────────────

def tts(text, out_path, api_key, voice_id):
    """Generate an MP3 voiceover from text via ElevenLabs."""
    resp = requests.post(
        f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}",
        headers={
            "xi-api-key":   api_key,
            "Content-Type": "application/json",
            "Accept":       "audio/mpeg",
        },
        json={
            "text":       text,
            "model_id":   "eleven_multilingual_v2",
            "voice_settings": {
                "stability":        0.55,
                "similarity_boost": 0.75,
                "use_speaker_boost": True,
            },
        },
        timeout=90,
    )
    if not resp.ok:
        raise RuntimeError(f"ElevenLabs {resp.status_code}: {resp.text[:300]}")
    Path(out_path).write_bytes(resp.content)


# ── ffmpeg helpers ────────────────────────────────────────────────────────────

def _audio_duration(path):
    """Return duration in seconds of an audio file using ffprobe."""
    r = subprocess.run(
        ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_streams", str(path)],
        capture_output=True, text=True,
    )
    try:
        for stream in json.loads(r.stdout).get("streams", []):
            if "duration" in stream:
                return float(stream["duration"])
    except Exception:
        pass
    return 6.0


def _make_clip(slide_path, audio_path, out_path):
    """Combine a slide image and an MP3 into an MP4 clip."""
    dur = _audio_duration(audio_path) + 0.5
    subprocess.run(
        [
            "ffmpeg", "-y",
            "-loop", "1", "-t", str(dur), "-i", str(slide_path),
            "-i", str(audio_path),
            "-c:v", "libx264", "-preset", "fast", "-tune", "stillimage",
            "-c:a", "aac", "-b:a", "128k",
            "-pix_fmt", "yuv420p", "-r", "24",
            "-movflags", "+faststart", "-shortest",
            str(out_path),
        ],
        check=True, capture_output=True,
    )


def _concat_clips(clips, out_path, work_dir):
    """Concatenate MP4 clips into a single video with ffmpeg concat demuxer."""
    fl = Path(work_dir) / "concat.txt"
    fl.write_text("\n".join(f"file '{Path(c).resolve()}'" for c in clips))
    subprocess.run(
        ["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(fl), "-c", "copy", str(out_path)],
        check=True, capture_output=True,
    )


# ── YouTube upload ────────────────────────────────────────────────────────────

def youtube_upload(video_path, thumbnail_path, title, description, tags):
    """Upload a video to YouTube using OAuth 2.0 refresh token credentials."""
    try:
        from google.oauth2.credentials import Credentials
        from google.auth.transport.requests import Request
        from googleapiclient.discovery import build
        from googleapiclient.http import MediaFileUpload
    except ImportError:
        print("  YouTube: google-api-python-client not installed. Skipping upload.")
        return None

    rt = os.environ.get("YOUTUBE_REFRESH_TOKEN", "")
    ci = os.environ.get("YOUTUBE_CLIENT_ID", "")
    cs = os.environ.get("YOUTUBE_CLIENT_SECRET", "")

    if not all([rt, ci, cs]):
        print("  YouTube: YOUTUBE_REFRESH_TOKEN, YOUTUBE_CLIENT_ID or YOUTUBE_CLIENT_SECRET "
              "not set in GitHub secrets. Skipping upload.")
        return None

    creds = Credentials(
        token=None,
        refresh_token=rt,
        client_id=ci,
        client_secret=cs,
        token_uri="https://oauth2.googleapis.com/token",
        scopes=["https://www.googleapis.com/auth/youtube.upload"],
    )
    creds.refresh(Request())

    yt = build("youtube", "v3", credentials=creds)

    body = {
        "snippet": {
            "title":           title[:100],
            "description":     description[:5000],
            "tags":            tags,
            "categoryId":      "27",          # Education
            "defaultLanguage": "en-GB",
        },
        "status": {
            "privacyStatus":           "public",
            "selfDeclaredMadeForKids": False,
        },
    }
    media   = MediaFileUpload(str(video_path), chunksize=-1, resumable=True, mimetype="video/mp4")
    request = yt.videos().insert(part="snippet,status", body=body, media_body=media)

    response = None
    while response is None:
        status, response = request.next_chunk()
        if status:
            pct = int(status.progress() * 100)
            print(f"  Uploading... {pct}%", end="\r", flush=True)

    vid = response["id"]
    print(f"  Uploaded: https://www.youtube.com/watch?v={vid}            ")

    # Set custom thumbnail (the Imagen 3 hero image)
    if thumbnail_path and Path(thumbnail_path).exists():
        yt.thumbnails().set(
            videoId=vid,
            media_body=MediaFileUpload(str(thumbnail_path)),
        ).execute()
        print("  Thumbnail set.")

    return vid


# ── Claude script generation ──────────────────────────────────────────────────

def _generate_script(title, content, description, api_key):
    """Use Claude Sonnet to write a structured 4-5 minute video script."""
    import anthropic as _ant

    client = _ant.Anthropic(api_key=api_key)
    prompt = (
        "You are writing a script for a 4 to 5 minute educational YouTube video "
        "for The Data and AI School of London.\n\n"
        f"Blog title: {title}\n"
        f"Blog summary: {description}\n\n"
        f"Blog content:\n{content[:5500]}\n\n"
        "Requirements:\n"
        "- British English throughout\n"
        "- Professional, authoritative tone for UK professionals\n"
        "- No em dashes or en dashes. Use commas, colons or full stops instead\n"
        "- Each bullet point: max 12 words, clear and readable on screen\n"
        "- Each section narration: 80 to 120 words of natural spoken English\n"
        "- Intro narration: 40 to 60 words with an engaging opening hook\n"
        "- Outro narration: 25 to 40 words with a clear call to action\n"
        "- 5 or 6 content sections with a clear heading each\n\n"
        "Return ONLY valid JSON in this exact format:\n"
        '{\n'
        '  "intro_narration": "...",\n'
        '  "sections": [\n'
        '    { "heading": "...", "bullets": ["...", "...", "..."], "narration": "..." }\n'
        '  ],\n'
        '  "outro_narration": "..."\n'
        '}'
    )

    msg  = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=2500,
        messages=[{"role": "user", "content": prompt}],
    )
    text = msg.content[0].text.strip()

    # Strip markdown code fences if present
    m = re.search(r"```(?:json)?\s*([\s\S]+?)\s*```", text)
    if m:
        text = m.group(1)

    return json.loads(text)


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    # Resolve blog file path
    if len(sys.argv) >= 2:
        blog_file = Path(sys.argv[1])
    else:
        new_files = os.environ.get("NEW_FILES", "").strip()
        htmls = [f for f in new_files.split() if f.endswith(".html")]
        if not htmls:
            print("No blog file specified. Pass as argument or set NEW_FILES.")
            return
        blog_file = Path(htmls[0])

    if not blog_file.exists():
        print(f"Blog file not found: {blog_file}")
        sys.exit(1)

    # Check required credentials
    anthropic_key  = os.environ.get("ANTHROPIC_API_KEY", "")
    elevenlabs_key = os.environ.get("ELEVENLABS_API_KEY", "")
    voice_id       = os.environ.get("ELEVENLABS_VOICE_ID", "pNInz6obpgDQGcFmaJgB")  # Adam

    if not anthropic_key:
        print("ANTHROPIC_API_KEY not set. Skipping video generation.")
        return
    if not elevenlabs_key:
        print("ELEVENLABS_API_KEY not set. Skipping video generation.")
        return

    # Parse blog HTML for metadata
    soup = BeautifulSoup(blog_file.read_text(encoding="utf-8"), "html.parser")

    def og(prop):
        tag = soup.find("meta", property=f"og:{prop}")
        return tag["content"].strip() if tag and tag.get("content") else ""

    title       = og("title") or (soup.title.string.strip() if soup.title else blog_file.stem)
    description = og("description") or ""
    image_url   = og("image") or ""
    post_url    = og("url") or f"{BASE_URL}/blog/{blog_file.name}"

    # Extract readable text (strip nav/script/footer)
    for el in soup.find_all(["script", "style", "nav", "footer", "header"]):
        el.decompose()
    content = soup.get_text(separator=" ", strip=True)

    # Derive local hero image path from og:image URL
    hero_local = None
    if image_url.startswith(BASE_URL + "/"):
        hero_local = image_url[len(BASE_URL) + 1:]

    print(f"Blog: {title}")

    # Generate video script via Claude
    print("Generating video script...")
    script   = _generate_script(title, content, description, anthropic_key)
    sections = script.get("sections", [])
    print(f"Script: {len(sections)} sections")

    slug = blog_file.stem
    work = Path(f"/tmp/dais_video_{slug}")
    work.mkdir(parents=True, exist_ok=True)

    try:
        clips = []

        # ── Slide 0: Title ────────────────────────────────────────────────────
        print("\nSlide 0: Title")
        s0, a0, c0 = work / "slide_00.png", work / "audio_00.mp3", work / "clip_00.mp4"
        slide_title(title, hero_local, s0)
        print("  Generating intro voiceover...")
        tts(script["intro_narration"], a0, elevenlabs_key, voice_id)
        _make_clip(s0, a0, c0)
        clips.append(c0)

        # ── Content slides ────────────────────────────────────────────────────
        for i, sec in enumerate(sections, 1):
            print(f"\nSlide {i}: {sec['heading']}")
            si = work / f"slide_{i:02d}.png"
            ai = work / f"audio_{i:02d}.mp3"
            ci = work / f"clip_{i:02d}.mp4"
            slide_content(sec["heading"], sec.get("bullets", []), i, len(sections), si)
            print(f"  Generating voiceover...")
            tts(sec["narration"], ai, elevenlabs_key, voice_id)
            _make_clip(si, ai, ci)
            clips.append(ci)

        # ── CTA slide ─────────────────────────────────────────────────────────
        print("\nSlide outro: CTA")
        sc, ac, cc = work / "slide_cta.png", work / "audio_cta.mp3", work / "clip_cta.mp4"
        slide_cta(sc)
        print("  Generating outro voiceover...")
        tts(script["outro_narration"], ac, elevenlabs_key, voice_id)
        _make_clip(sc, ac, cc)
        clips.append(cc)

        # ── Assemble final video ──────────────────────────────────────────────
        print("\nAssembling final video...")
        final = work / f"{slug}.mp4"
        _concat_clips(clips, final, work)
        mb = final.stat().st_size // (1024 * 1024)
        print(f"Video ready: {final} ({mb} MB)")

        # ── Upload to YouTube ─────────────────────────────────────────────────
        yt_title = f"{title} | DAIS London"
        yt_desc  = YT_DESC.format(description=description, url=post_url)
        yt_tags  = [
            "Data Science", "AI", "Machine Learning", "UK Education", "DAIS",
            "London", "NCFE", "Ofqual", "Artificial Intelligence", "Career Advice",
            "Python", "Data Science Course UK",
        ]
        thumbnail = Path(hero_local) if hero_local and Path(hero_local).exists() else None

        print("\nUploading to YouTube...")
        vid = youtube_upload(final, thumbnail, yt_title, yt_desc, yt_tags)

        if vid:
            print(f"\nVideo live: https://www.youtube.com/watch?v={vid}")
        else:
            print(f"\nVideo generated locally (YouTube upload skipped): {final}")

    finally:
        shutil.rmtree(work, ignore_errors=True)
        print("Temporary files cleaned up.")


if __name__ == "__main__":
    main()
