# Production Deployment Guide

This guide walks through deploying Orcabot to production with proper security lockdown.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                     CLOUDFLARE ACCESS                            │
│              (Your email = only allowed user)                    │
└─────────────────────┬───────────────────────────────────────────┘
                      │ JWT with identity
                      ▼
┌─────────────────────────────────────────────────────────────────┐
│              CLOUDFLARE PAGES (Frontend)                         │
│         (Static Next.js, protected by Access)                    │
└─────────────────────┬───────────────────────────────────────────┘
                      │ API calls with CF Access JWT
                      ▼
┌─────────────────────────────────────────────────────────────────┐
│           CLOUDFLARE WORKER (Control Plane)                      │
│    - Validates CF Access JWT                                     │
│    - Rate limiting (60/min)                                      │
│    - ALLOWED_ORIGINS set to frontend domain                      │
└─────────────────────┬───────────────────────────────────────────┘
                      │ X-Internal-Token
                      ▼
┌─────────────────────────────────────────────────────────────────┐
│               FLY.IO (Sandbox)                                   │
│    - Only accepts SANDBOX_INTERNAL_TOKEN                         │
│    - Not publicly accessible for API calls                       │
└─────────────────────────────────────────────────────────────────┘
```

## Prerequisites

- Cloudflare account with Workers and Pages enabled
- Fly.io account with sandbox deployed
- `wrangler` CLI installed (`npm install -g wrangler`)
- Domain name (can be registered anywhere)

## Step 1: Add Your Domain to Cloudflare

If your domain is registered elsewhere (e.g., GoDaddy, Namecheap), you need to add it to Cloudflare and update nameservers.

### 1.1 Add Domain to Cloudflare

1. Log in to [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. Click **+ Add** (top right) → **Connect a domain**
3. Enter your domain (e.g., `orcabot.com`) and click **Continue**
4. Select **Quick scan for DNS records** - Cloudflare will import existing records
5. Review the scanned DNS records and click **Continue**
6. Select the **Free** plan (sufficient for this setup)
7. Cloudflare will show you two nameservers, e.g.:
   - `aria.ns.cloudflare.com`
   - `duke.ns.cloudflare.com`

### 1.2 Update Nameservers at Your Registrar (GoDaddy Example)

1. Log in to [GoDaddy](https://www.godaddy.com/)
2. Go to **My Products** → **Domains** → click your domain
3. Scroll to **Nameservers** and click **Change**
4. Select **Enter my own nameservers (advanced)**
5. Enter the two Cloudflare nameservers from step 1.1
6. Save changes

**Note:** Nameserver propagation can take up to 24-48 hours, but usually completes within 1-2 hours.

### 1.3 Verify Domain is Active

1. Return to Cloudflare Dashboard
2. Click **Check nameservers** or wait for email confirmation
3. Once active, you'll see a green checkmark next to your domain

### 1.4 Configure SSL/TLS

1. In Cloudflare, go to your domain → **SSL/TLS**
2. Set encryption mode to **Full (strict)**
3. Go to **Edge Certificates** and enable **Always Use HTTPS**

## Step 2: Set Up Cloudflare Access

Cloudflare Access provides zero-trust authentication at the edge.

### 2.1 Create a Cloudflare Access Team

1. Go to [Cloudflare Zero Trust Dashboard](https://one.dash.cloudflare.com/)
2. Set up your team domain (e.g., `myteam.cloudflareaccess.com`)
3. Note your team domain name (just `myteam`, not the full URL)

### 2.2 Create an Access Application

1. Go to **Access → Applications → Add an Application**
2. Choose **Self-hosted**
3. Configure:
   - **Application name**: Orcabot
   - **Session duration**: 24 hours (or your preference)
   - **Application domain**: Your domain (e.g., `orcabot.com`)

4. Create an access policy:
   - **Policy name**: Allow Me
   - **Action**: Allow
   - **Include**: Emails = your email address

5. After saving, note the **Application Audience (AUD) tag** from the overview page

### 2.3 Add Control Plane to Same Access Application

Add the control plane as an additional subdomain in the same Access application:
- Add subdomain: `api.orcabot.com` (or `orcabot-controlplane.YOUR_SUBDOMAIN.workers.dev` if not using custom domain)

This ensures both frontend and API are protected by the same Access policy.

## Step 3: Deploy the Control Plane

### 3.1 Create Production D1 Database

```bash
cd controlplane
wrangler d1 create orcabot-db-production
```

Note the database ID and update `wrangler.production.toml`:
```toml
[[d1_databases]]
binding = "DB"
database_name = "orcabot-db-production"
database_id = "YOUR_DATABASE_ID_HERE"
```

### 3.2 Configure Production Environment Variables

Update `wrangler.production.toml` with your values:

```toml
[vars]
DEV_AUTH_ENABLED = "false"
CF_ACCESS_TEAM_DOMAIN = "myteam"  # Your team domain
CF_ACCESS_AUD = "xxxxx"           # Your AUD tag from step 2.2
ALLOWED_ORIGINS = "https://orcabot.com"  # Your frontend URL
```

### 3.3 Set Secrets

Never store secrets in wrangler.toml. Use `wrangler secret`:

```bash
# Generate new secure tokens
SANDBOX_TOKEN=$(openssl rand -base64 32)
INTERNAL_TOKEN=$(openssl rand -base64 32)

# Set secrets for production
wrangler secret put SANDBOX_URL -c wrangler.production.toml
# Paste your sandbox URL (e.g., https://your-sandbox.fly.dev/)

wrangler secret put SANDBOX_INTERNAL_TOKEN -c wrangler.production.toml
# Paste: $SANDBOX_TOKEN

wrangler secret put INTERNAL_API_TOKEN -c wrangler.production.toml
# Paste: $INTERNAL_TOKEN

# If using OAuth integrations
wrangler secret put GOOGLE_CLIENT_SECRET -c wrangler.production.toml
wrangler secret put GITHUB_CLIENT_SECRET -c wrangler.production.toml
```

### 3.4 Deploy Control Plane

```bash
wrangler deploy -c wrangler.production.toml
```

### 3.5 (Optional) Add Custom Domain for API

If you want to use `api.orcabot.com` instead of the workers.dev URL:

1. In Cloudflare Dashboard, go to **Workers & Pages** → your worker
2. Go to **Settings → Triggers → Custom Domains**
3. Add `api.orcabot.com`
4. Update `ALLOWED_ORIGINS` if needed to allow requests from your frontend

## Step 4: Update Sandbox Configuration

### 4.1 Set the Same Internal Token

The sandbox must use the same `SANDBOX_INTERNAL_TOKEN` as the control plane.

```bash
fly secrets set SANDBOX_INTERNAL_TOKEN="$SANDBOX_TOKEN" -a orcabot-sandbox
```

## Step 5: Deploy the Frontend

### 5.1 Configure Environment

Create `frontend/.env.production`:
```
NEXT_PUBLIC_API_URL=https://api.orcabot.com
```

(Or use `https://orcabot-controlplane.YOUR_SUBDOMAIN.workers.dev` if not using custom domain)

### 5.2 Build and Deploy to Cloudflare Pages

```bash
cd frontend

# Build for Cloudflare Pages
npm run pages:build

# Deploy
npm run pages:deploy
```

Or set up automatic deployments via GitHub:
1. Go to Cloudflare Dashboard → Pages
2. Connect your GitHub repo
3. Configure build settings:
   - Build command: `npm run pages:build`
   - Build output directory: `.vercel/output/static`
   - Root directory: `frontend`

### 5.3 Add Custom Domain to Pages

1. In Cloudflare Dashboard, go to **Workers & Pages** → your Pages project
2. Go to **Custom domains** → **Set up a custom domain**
3. Enter `orcabot.com`
4. Cloudflare will automatically configure DNS

## Step 6: Verify Security

### 6.1 Test Access Restriction

Try accessing your frontend without authentication:
- You should be redirected to Cloudflare Access login
- Only your allowed email should be able to log in

### 6.2 Test API Protection

```bash
# This should fail with 401 (no CF Access JWT)
curl https://api.orcabot.com/api/dashboards

# This should fail with 401 (invalid token)
curl https://orcabot-sandbox.fly.dev/health  # OK - health is public
curl https://orcabot-sandbox.fly.dev/sessions  # 401 - requires token
```

### 6.3 Verify Rate Limiting

```bash
# Rapid requests should eventually hit rate limit
for i in {1..100}; do
  curl -s -o /dev/null -w "%{http_code}\n" https://api.orcabot.com/api/health
done
# Should see 429 responses after ~60 requests
```

## Security Checklist

- [ ] Domain added to Cloudflare with nameservers updated
- [ ] SSL/TLS set to Full (strict)
- [ ] `DEV_AUTH_ENABLED=false` in production config
- [ ] `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` configured
- [ ] `ALLOWED_ORIGINS` set to frontend domain only (e.g., `https://orcabot.com`)
- [ ] Secrets stored via `wrangler secret`, not in toml files
- [ ] New random tokens generated for production
- [ ] Cloudflare Access policy restricts to your email only
- [ ] Sandbox requires `SANDBOX_INTERNAL_TOKEN` for all API calls
- [ ] Rate limiting enabled (60/min default)

## Troubleshooting

### "Authentication required" error

1. Check that Cloudflare Access is properly configured
2. Verify `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` match your Access application
3. Ensure your email is in the Access policy

### CORS errors

1. Check `ALLOWED_ORIGINS` includes your frontend URL exactly
2. Include protocol: `https://orcabot.com` not just `orcabot.com`

### Sandbox connection failures

1. Verify `SANDBOX_INTERNAL_TOKEN` matches between control plane and sandbox
2. Check sandbox is running: `fly status -a orcabot-sandbox`
3. Check `SANDBOX_URL` is correct in control plane config

### Nameserver propagation issues

1. Use [DNS Checker](https://dnschecker.org/) to verify propagation
2. Clear browser DNS cache or try incognito mode
3. Wait up to 24-48 hours for full propagation (usually faster)

### Rate limit hit too quickly

Increase the limit in `wrangler.production.toml`:
```toml
simple = { limit = 120, period = 60 }  # 120 requests per minute
```
