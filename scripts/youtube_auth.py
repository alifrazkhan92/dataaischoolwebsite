#!/usr/bin/env python3
"""
YouTube OAuth Setup
===================
Run this ONCE on your local machine. It opens a browser for Google sign-in,
then automatically pushes all three credentials to GitHub secrets.
No terminal copying required.

Prerequisites:
  pip install google-auth-oauthlib

Usage:
  python scripts/youtube_auth.py path/to/client_secret.json
"""

import sys
import json
import subprocess
from pathlib import Path


SCOPES = [
    "https://www.googleapis.com/auth/youtube.upload",
    "https://www.googleapis.com/auth/youtube",   # needed to create/manage playlists
]
REPO   = "alifrazkhan92/dataaischoolwebsite"
BACKUP = Path("/tmp/yt_credentials_backup.json")


def gh_secret(name, value):
    """Push a single secret to GitHub via the gh CLI."""
    result = subprocess.run(
        ["gh", "secret", "set", name, "--body", value, "--repo", REPO],
        capture_output=True, text=True,
    )
    if result.returncode == 0:
        print(f"  GitHub secret set: {name}")
    else:
        print(f"  WARNING: could not set {name} via gh CLI: {result.stderr.strip()}")


def main():
    try:
        from google_auth_oauthlib.flow import InstalledAppFlow
    except ImportError:
        print("Missing package. Run: pip install google-auth-oauthlib")
        sys.exit(1)

    secrets_file = sys.argv[1] if len(sys.argv) > 1 else "client_secret.json"

    if not Path(secrets_file).exists():
        print(f"File not found: {secrets_file}")
        sys.exit(1)

    print(f"Using: {secrets_file}")
    print("A browser window will open. Sign in with the DAIS Google account.\n")

    flow  = InstalledAppFlow.from_client_secrets_file(secrets_file, SCOPES)
    creds = flow.run_local_server(port=0)

    data = {
        "YOUTUBE_REFRESH_TOKEN": creds.refresh_token,
        "YOUTUBE_CLIENT_ID":     creds.client_id,
        "YOUTUBE_CLIENT_SECRET": creds.client_secret,
    }

    # Save backup to disk immediately (survives terminal close)
    BACKUP.write_text(json.dumps(data, indent=2))
    print(f"\nCredentials saved to {BACKUP} (backup in case anything fails below)")

    # Push directly to GitHub secrets
    print("\nPushing to GitHub secrets...")
    for name, value in data.items():
        gh_secret(name, value)

    print("\nDone. All three YouTube secrets are now set in GitHub.")
    print("You can delete the backup file when ready:")
    print(f"  rm {BACKUP}")


if __name__ == "__main__":
    main()
