# Running Video Autopilot on an EC2 instance

This guide and `scripts/ec2-setup.sh` have **not been run on a real instance yet**. Treat the first run as a test and read the output.

## What you need

- An EC2 instance running **Ubuntu 24.04 or newer**. Video rendering is CPU-heavy: 4 vCPU / 8 GB (for example `t3.xlarge` or `c7i.xlarge`) and a 40 GB disk is a sensible start.
- A **domain name** pointing at the instance (an A record to its Elastic IP). HTTPS needs a name; Google and Meta sign-in need HTTPS.
- Security group: allow **80 and 443** from anywhere, **22** from your own IP only. Do not open 4317.
- An **S3 bucket** (private) and an **IAM role** attached to the instance allowing `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject` on `arn:aws:s3:::BUCKET/*` and `s3:ListBucket` on `arn:aws:s3:::BUCKET`.

## Install

```bash
git clone <your repository> video-autopilot && cd video-autopilot
DOMAIN=videos.example.com ADMIN_PASSWORD='a-long-password' S3_BUCKET=my-bucket AWS_REGION=ap-south-1 bash scripts/ec2-setup.sh
```

The script installs Node 24, ffmpeg, Python, uv, Caddy (HTTPS) and Claude Code, builds the app, and runs it as a service that restarts on reboot. The app listens only on the instance itself; Caddy is the only thing reachable from outside.

Then:

1. **Sign Claude Code in** over SSH: run `claude`, type `/login`, open the link it prints, and paste the code back. This uses your subscription, the same as on your Mac.
2. Open `https://your-domain` and sign in with the admin password.
3. **Settings → Setup checks**: press *Install video tools* and fix anything still red. The check wants **ffmpeg 7 or newer**; if your Ubuntu version ships an older one, upgrade the instance's Ubuntu release or install a newer ffmpeg build.
4. **Settings → Cloud storage**: enter the bucket and region, leave the key fields empty (the instance role is used), and press *Test connection*.

## Moving your data from the Mac

1. On the Mac: Settings → Cloud storage → *Upload everything now* (uploads files and a database backup).
2. On the server, stop the app and put the database and key in place:
   ```bash
   sudo systemctl stop video-autopilot
   aws s3 cp s3://BUCKET/video-autopilot/backups/app-latest.db data/app.db
   # copy data/secret.key from the Mac yourself (scp); it is never uploaded to S3
   sudo systemctl start video-autopilot
   ```
   Without `secret.key` the saved YouTube and Instagram sign-ins cannot be read; reconnect the channels instead.
3. Settings → Cloud storage → *Restore missing files*.

Run the pipeline on **one machine at a time**. Two machines working from copies of the same database would both publish.

## Redirect addresses

Sign-in links now use your domain. Add these where you added the `localhost` ones:

- Google Cloud → your OAuth client → Authorized redirect URIs:
  `https://your-domain/api/oauth/youtube/callback` and `https://your-domain/api/auth/google/callback`
- Meta → Facebook Login for Business → Valid OAuth Redirect URIs:
  `https://your-domain/api/oauth/instagram/callback`

## Sign-in

- **Admin password**: full access. Set by `ADMIN_PASSWORD` in `/etc/video-autopilot.env` or in Settings → Access. Lost it: `npm run admin-password -- 'new-password'` on the server, then restart.
- **Google sign-in**: Settings → Access → add the allowed emails. Those people can make, review and publish videos but cannot change settings, keys, channels or the list.
- The app refuses to start on a public address (`HOST=0.0.0.0`) without an admin password.

## Day to day

```bash
journalctl -u video-autopilot -f          # logs
sudo systemctl restart video-autopilot    # restart
git pull && npm install && npm run build && sudo systemctl restart video-autopilot   # update
```

## Not verified yet

- Claude Code signed in to a subscription on a headless server.
- The video skill's renderer on Linux (it may need extra system libraries for its headless browser; the *Install video tools* log will say).
- Real AWS S3 and the instance role (covered by tests against a stand-in only).
