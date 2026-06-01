# Social Media Auto-Share Setup

When a new blog post is committed to `blog/` the GitHub Action
`.github/workflows/social-share.yml` automatically shares it to
Facebook, Instagram and LinkedIn.

Five secrets must be added to the GitHub repository before it works.
Go to: **GitHub repo → Settings → Secrets and variables → Actions → New repository secret**

---

## Secret 1 and 2: Facebook Page

### FB_PAGE_ACCESS_TOKEN

1. Go to https://developers.facebook.com and create an App (type: Business)
2. Add the **Pages API** product to your app
3. Go to **Tools → Graph API Explorer**
4. Select your app and your Facebook Page from the dropdowns
5. Add permissions: `pages_manage_posts`, `pages_read_engagement`
6. Click **Generate Access Token** and log in
7. Copy the token — it expires in 1 hour by default
8. To make it long-lived (60 days), exchange it:
   ```
   GET https://graph.facebook.com/oauth/access_token
     ?grant_type=fb_exchange_token
     &client_id=YOUR_APP_ID
     &client_secret=YOUR_APP_SECRET
     &fb_exchange_token=SHORT_LIVED_TOKEN
   ```
9. For a never-expiring Page token, use the long-lived user token to call:
   ```
   GET https://graph.facebook.com/me/accounts?access_token=LONG_LIVED_USER_TOKEN
   ```
   The `access_token` in the response for your Page never expires.

### FB_PAGE_ID

1. Go to your Facebook Page
2. Click **About** (or **Page transparency**)
3. Scroll to the bottom — the Page ID is a long number like `123456789012345`

---

## Secret 3: Instagram

### IG_USER_ID

Requirements:
- Instagram account must be a **Business** or **Creator** account
- The Instagram account must be **connected to your Facebook Page**
  (Facebook Page Settings → Instagram → Connect account)

To get the Instagram User ID:
```
GET https://graph.facebook.com/v19.0/me/accounts?access_token=FB_PAGE_ACCESS_TOKEN
```
Find your page in the response, then:
```
GET https://graph.facebook.com/v19.0/{PAGE_ID}?fields=instagram_business_account&access_token=FB_PAGE_ACCESS_TOKEN
```
The `id` inside `instagram_business_account` is your `IG_USER_ID`.

Also make sure your Facebook App has these permissions approved:
- `instagram_basic`
- `instagram_content_publish`

---

## Secret 4 and 5: LinkedIn

LinkedIn tokens expire every 60 days. You will need to refresh them periodically.

### LI_ACCESS_TOKEN

1. Go to https://linkedin.com/developers and create an app
2. Under **Products**, request access to **Share on LinkedIn** and
   **Sign In with LinkedIn using OpenID Connect**
3. Wait for approval (usually instant for Share on LinkedIn)
4. Go to **Auth** tab, add `https://www.linkedin.com/developers/tools/oauth/redirect`
   as a redirect URL
5. Use the OAuth 2.0 token generator in the Developer portal:
   - Scopes needed: `w_member_social` (personal) or `w_organization_social` (company page)
   - Click **Request access token**
   - Copy the **Access Token**

### LI_AUTHOR_URN

For a **personal profile**:
```
GET https://api.linkedin.com/v2/me
Authorization: Bearer YOUR_ACCESS_TOKEN
```
The `id` field gives you a string like `aBcDeFgH`. Your URN is:
`urn:li:person:aBcDeFgH`

For a **company / school page** (recommended for DAIS):
```
GET https://api.linkedin.com/v2/organizationalEntityAcls?q=roleAssignee
Authorization: Bearer YOUR_ACCESS_TOKEN
```
Find your organisation ID. Your URN is:
`urn:li:organization:12345678`

Use the organisation URN so posts appear from the DAIS page, not your personal profile.

---

## Adding secrets to GitHub

1. Open your repository on GitHub
2. Go to **Settings → Secrets and variables → Actions**
3. Click **New repository secret** for each of the five secrets:

| Secret name           | Value                          |
|-----------------------|--------------------------------|
| FB_PAGE_ACCESS_TOKEN  | The never-expiring page token  |
| FB_PAGE_ID            | Numeric Page ID                |
| IG_USER_ID            | Numeric Instagram User ID      |
| LI_ACCESS_TOKEN       | LinkedIn OAuth access token    |
| LI_AUTHOR_URN         | urn:li:organization:XXXXXXXX   |

---

## Testing

To test without publishing a real post, you can run the script locally:

```bash
export NEW_FILES="blog/what-is-data-science-uk-guide.html"
export FB_PAGE_ACCESS_TOKEN="your-token"
export FB_PAGE_ID="your-page-id"
export IG_USER_ID="your-ig-id"
export LI_ACCESS_TOKEN="your-li-token"
export LI_AUTHOR_URN="urn:li:organization:12345678"

python scripts/social_share.py
```

---

## How it works

1. You commit a new `.html` file to the `blog/` folder and push to `main`
2. GitHub Actions detects the new file (not edits to existing posts)
3. The script reads `og:title`, `og:description`, `og:image` and `og:url` from the HTML
4. Posts are shared to all three platforms within about 60 seconds of your push

No action is needed from you after the initial setup. Just push the blog post and it shares automatically.
