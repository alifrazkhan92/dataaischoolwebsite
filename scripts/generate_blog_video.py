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
import time
import requests
from pathlib import Path
from bs4 import BeautifulSoup
from PIL import Image, ImageDraw, ImageFont

try:
    from google import genai as _genai
    from google.genai import types as _genai_types
    VEO3_AVAILABLE = True
except ImportError:
    VEO3_AVAILABLE = False

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
    path = Path("images/logo-dais-new.png")
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


# ── Veo 3 video generation ───────────────────────────────────────────────────

_VEO3_VISUAL_THEMES = {
    "python":       "Python code flowing across holographic displays, developer workspace",
    "machine learn": "abstract neural network nodes firing, data flowing through layers",
    "deep learn":   "layered neural network visualisation, glowing synaptic connections",
    "data":         "data streams and analytics dashboards, professional business environment",
    "ai":           "futuristic artificial intelligence visualisation, circuit patterns",
    "cloud":        "cloud infrastructure servers and data centres, clean tech environment",
    "security":     "cybersecurity encrypted data streams, digital lock patterns",
    "automation":   "robotic process automation, digital workflows and gears turning",
    "nlp":          "natural language processing word clouds and text analysis visualisation",
    "llm":          "large language model token streams, transformer attention patterns",
    "pipeline":     "data engineering pipeline diagram, flowing ETL processes",
    "api":          "API calls and microservices diagram, interconnected nodes",
}


def _veo3_prompt(heading, topic_title):
    """Build a Veo 3 visual prompt for a section heading."""
    lower = heading.lower()
    visual = "professional educational technology setting, modern workspace, blue lighting"
    for key, theme in _VEO3_VISUAL_THEMES.items():
        if key in lower:
            visual = theme
            break
    return (
        f"Cinematic 4K footage for an educational video titled '{heading}' "
        f"within the course '{topic_title}'. {visual}. "
        "Colour palette: deep navy blue and gold accents. "
        "Professional, inspiring, clean composition. No text, no people's faces. "
        "Smooth slow camera movement. High production quality. 16:9 aspect ratio."
    )


def _veo3_clip(prompt, out_path, gemini_key):
    """Generate an 8-second video clip via Google Veo 3.

    Polls the long-running operation until complete (~2-5 min per clip).
    Raises RuntimeError on failure so caller can fall back to PIL slide.
    """
    client = _genai.Client(api_key=gemini_key)

    operation = client.models.generate_videos(
        model="veo-3.0-generate-preview",
        prompt=prompt,
        config=_genai_types.GenerateVideosConfig(
            aspect_ratio="16:9",
            duration_seconds=8,
            number_of_videos=1,
            generate_audio=False,  # ElevenLabs provides narration
        ),
    )

    print("  Veo 3 generating", end="", flush=True)
    while not operation.done:
        time.sleep(20)
        print(".", end="", flush=True)
        operation = client.operations.get(operation)
    print(" done")

    if getattr(operation, "error", None) and getattr(operation.error, "code", 0):
        raise RuntimeError(f"Veo 3 error {operation.error.code}: {operation.error.message}")

    for video in operation.response.generated_videos:
        vid_obj = video.video
        # SDK returns either inline bytes or a URI-backed file
        if vid_obj.video_bytes:
            Path(out_path).write_bytes(vid_obj.video_bytes)
        elif vid_obj.uri:
            data = client.files.download(file=vid_obj)
            Path(out_path).write_bytes(data)
        else:
            raise RuntimeError("Veo 3: video has neither bytes nor URI")
        return out_path

    raise RuntimeError("Veo 3: no video returned in response")


def _veo3_make_clip(veo_raw, audio_path, heading, out_path):
    """Loop a Veo 3 raw clip to match audio duration, add narration audio and heading overlay."""
    dur = _audio_duration(audio_path) + 0.5

    # Escape heading for ffmpeg drawtext
    safe_heading = (
        heading.replace("\\", "\\\\")
               .replace("'", "\\'")
               .replace(":", "\\:")
               .replace("[", "\\[")
               .replace("]", "\\]")
    )

    font_candidates = [
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    ]
    font_path = next((f for f in font_candidates if Path(f).exists()), None)

    if font_path:
        vf = (
            f"drawbox=x=0:y=0:w=iw:h=76:color=0x0A2240@0.92:t=fill,"
            f"drawtext=fontfile={font_path}:text='{safe_heading}':"
            f"fontsize=44:fontcolor=0xE8A020:x=84:y=20"
        )
    else:
        vf = "null"

    subprocess.run(
        [
            "ffmpeg", "-y",
            "-stream_loop", "-1", "-i", str(veo_raw),
            "-i", str(audio_path),
            "-filter_complex", f"[0:v]{vf}[v]",
            "-map", "[v]", "-map", "1:a",
            "-c:v", "libx264", "-preset", "fast",
            "-c:a", "aac", "-b:a", "128k",
            "-pix_fmt", "yuv420p", "-r", "24",
            "-movflags", "+faststart",
            "-t", str(dur),
            str(out_path),
        ],
        check=True, capture_output=True,
    )


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

def _generate_script(title, content, description, api_key, target_minutes=5):
    """Use Claude Sonnet to write a structured video script.

    target_minutes controls length: 5 for short blog videos, 15 for training videos.
    """
    import anthropic as _ant

    client = _ant.Anthropic(api_key=api_key)

    if target_minutes >= 15:
        sections_req = "12 to 14"
        narration_req = "140 to 170"
        intro_req = "60 to 80"
        outro_req = "50 to 70"
        max_tokens = 6000
        duration_label = "15 minute"
    else:
        sections_req = "5 or 6"
        narration_req = "80 to 120"
        intro_req = "40 to 60"
        outro_req = "25 to 40"
        max_tokens = 2500
        duration_label = "4 to 5 minute"

    prompt = (
        f"You are writing a script for a {duration_label} educational YouTube video "
        "for The Data and AI School of London.\n\n"
        f"Blog title: {title}\n"
        f"Blog summary: {description}\n\n"
        f"Blog content:\n{content[:8000]}\n\n"
        "Requirements:\n"
        "- British English throughout\n"
        "- Professional, authoritative tone for UK professionals\n"
        "- No em dashes or en dashes. Use commas, colons or full stops instead\n"
        "- Each bullet point: max 12 words, clear and readable on screen\n"
        f"- Each section narration: {narration_req} words of natural spoken English\n"
        f"- Intro narration: {intro_req} words with an engaging opening hook\n"
        f"- Outro narration: {outro_req} words with a clear call to action\n"
        f"- {sections_req} content sections with a clear heading each\n"
        "- 4 to 6 bullet points per section\n\n"
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
        max_tokens=max_tokens,
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

    # Reject path traversal: file must be inside blog/ or the repo root
    repo_root   = Path(__file__).resolve().parent.parent
    allowed_dir = repo_root / "blog"
    try:
        blog_file.resolve().relative_to(allowed_dir)
    except ValueError:
        print(f"Rejected: {blog_file} is outside the blog/ directory.")
        sys.exit(1)

    # Check required credentials
    anthropic_key  = os.environ.get("ANTHROPIC_API_KEY", "")
    elevenlabs_key = os.environ.get("ELEVENLABS_API_KEY", "")
    voice_id       = os.environ.get("ELEVENLABS_VOICE_ID", "pNInz6obpgDQGcFmaJgB")  # Adam
    gemini_key     = os.environ.get("GEMINI_API_KEY", "")

    use_veo3  = VEO3_AVAILABLE and bool(gemini_key)
    veo3_only = os.environ.get("VEO3_ONLY", "").lower() in ("1", "true", "yes")

    if use_veo3:
        print("Veo 3 mode: cinematic video clips will replace static slides.")
    elif veo3_only:
        print("VEO3_ONLY is set but Veo 3 is unavailable (missing key or package). Aborting.")
        sys.exit(1)
    else:
        print("PIL slide mode (set GEMINI_API_KEY and install google-genai for Veo 3).")

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
    target_minutes = int(os.environ.get("VIDEO_DURATION_MINS", "5"))
    print(f"Generating video script (target: {target_minutes} min)...")
    script   = _generate_script(title, content, description, anthropic_key, target_minutes)
    sections = script.get("sections", [])
    print(f"Script: {len(sections)} sections")

    slug = blog_file.stem
    work = Path(f"/tmp/dais_video_{slug}")
    work.mkdir(parents=True, exist_ok=True)

    try:
        clips = []

        # ── Clip 0: Title / Intro ─────────────────────────────────────────────
        print("\nClip 0: Title")
        a0, c0 = work / "audio_00.mp3", work / "clip_00.mp4"
        print("  Generating intro voiceover...")
        tts(script["intro_narration"], a0, elevenlabs_key, voice_id)

        def _veo3_or_abort(prompt, raw_path, audio_path, heading, clip_path, pil_fallback_fn):
            """Try Veo 3; if it fails abort when VEO3_ONLY, else run pil_fallback_fn."""
            try:
                _veo3_clip(prompt, raw_path, gemini_key)
                _veo3_make_clip(raw_path, audio_path, heading, clip_path)
            except Exception as exc:
                if veo3_only:
                    raise RuntimeError(f"Veo 3 failed and VEO3_ONLY is set: {exc}") from exc
                print(f"  Veo 3 failed ({exc}). Falling back to PIL slide.")
                pil_fallback_fn()

        if use_veo3:
            raw0 = work / "veo_00.mp4"
            intro_prompt = (
                f"Cinematic 4K title sequence for an educational YouTube video: '{title}'. "
                "Abstract data and AI visualisation. Deep navy blue with gold particles. "
                "Professional, inspiring. Smooth camera drift. No text. No faces."
            )
            def _title_pil():
                slide_title(title, hero_local, work / "slide_00.png")
                _make_clip(work / "slide_00.png", a0, c0)
            _veo3_or_abort(intro_prompt, raw0, a0, title, c0, _title_pil)
        else:
            slide_title(title, hero_local, work / "slide_00.png")
            _make_clip(work / "slide_00.png", a0, c0)
        clips.append(c0)

        # ── Content clips ─────────────────────────────────────────────────────
        for i, sec in enumerate(sections, 1):
            print(f"\nClip {i}: {sec['heading']}")
            ai = work / f"audio_{i:02d}.mp3"
            ci = work / f"clip_{i:02d}.mp4"
            print("  Generating voiceover...")
            tts(sec["narration"], ai, elevenlabs_key, voice_id)

            if use_veo3:
                raw_i = work / f"veo_{i:02d}.mp4"
                def _content_pil(s=sec, idx=i):
                    si = work / f"slide_{idx:02d}.png"
                    slide_content(s["heading"], s.get("bullets", []), idx, len(sections), si)
                    _make_clip(si, ai, ci)
                _veo3_or_abort(_veo3_prompt(sec["heading"], title), raw_i, ai, sec["heading"], ci, _content_pil)
            else:
                si = work / f"slide_{i:02d}.png"
                slide_content(sec["heading"], sec.get("bullets", []), i, len(sections), si)
                _make_clip(si, ai, ci)
            clips.append(ci)

        # ── Outro / CTA clip ──────────────────────────────────────────────────
        print("\nClip outro: CTA")
        ac, cc = work / "audio_cta.mp3", work / "clip_cta.mp4"
        print("  Generating outro voiceover...")
        tts(script["outro_narration"], ac, elevenlabs_key, voice_id)

        if use_veo3:
            raw_c = work / "veo_cta.mp4"
            cta_prompt = (
                "Cinematic 4K closing sequence. Abstract data and AI visualisation fading "
                "to deep navy blue. Gold particle effects. The Data and AI School of London. "
                "Professional, warm, inspiring. Smooth slow zoom out. No text. No faces."
            )
            def _cta_pil():
                sc = work / "slide_cta.png"
                slide_cta(sc)
                _make_clip(sc, ac, cc)
            _veo3_or_abort(cta_prompt, raw_c, ac, "www.dataaischool.com", cc, _cta_pil)
        else:
            sc = work / "slide_cta.png"
            slide_cta(sc)
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
