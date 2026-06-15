#!/usr/bin/env python3
"""
YouTube OAuth Setup
===================
Run this ONCE on your local machine to generate a YouTube refresh token.
The token is then stored as a GitHub secret so CI can upload videos automatically.

Prerequisites:
  pip install google-auth-oauthlib

Steps:
  1. Go to https://console.cloud.google.com
  2. Select the DAIS project (the same one used for Gemini/Imagen 3)
  3. Go to APIs and Services > Enable APIs > search for "YouTube Data API v3" and enable it
  4. Go to APIs and Services > Credentials
  5. Click "Create Credentials" > "OAuth client ID" > Application type: "Desktop app"
  6. Download the JSON file (e.g. client_secret.json)
  7. Run this script:
       python scripts/youtube_auth.py path/to/client_secret.json
  8. A browser window opens. Sign in with the DAIS Google account and allow access.
  9. Copy the three values printed at the end into GitHub repository secrets:
       Settings > Secrets and variables > Actions > New repository secret

GitHub secrets to create:
  YOUTUBE_REFRESH_TOKEN
  YOUTUBE_CLIENT_ID
  YOUTUBE_CLIENT_SECRET
"""

import sys


SCOPES = ["https://www.googleapis.com/auth/youtube.upload"]


def main():
    try:
        from google_auth_oauthlib.flow import InstalledAppFlow
    except ImportError:
        print("Missing package. Run: pip install google-auth-oauthlib")
        sys.exit(1)

    secrets_file = sys.argv[1] if len(sys.argv) > 1 else "client_secret.json"

    print(f"Using credentials file: {secrets_file}")
    print("A browser window will open. Sign in with the DAIS Google account.\n")

    flow  = InstalledAppFlow.from_client_secrets_file(secrets_file, SCOPES)
    creds = flow.run_local_server(port=0)

    print("\n" + "=" * 64)
    print("Add these three values as GitHub repository secrets:")
    print("Settings > Secrets and variables > Actions > New repository secret")
    print("=" * 64)
    print(f"  YOUTUBE_REFRESH_TOKEN  =  {creds.refresh_token}")
    print(f"  YOUTUBE_CLIENT_ID      =  {creds.client_id}")
    print(f"  YOUTUBE_CLIENT_SECRET  =  {creds.client_secret}")
    print("=" * 64)
    print("\nDo NOT commit these values to your repository.")


if __name__ == "__main__":
    main()
