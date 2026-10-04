# Skyward on Netlify — complete setup guide

This guide walks through publishing the iPhone satellite-camera site on Netlify's free plan. The matching download is **`Skyward-Netlify-Free.zip`**.

## What you are deploying

Skyward needs both a website and a small server API: the phone downloads the static app, while `GET /api/catalog` gets public satellite-orbit data. Netlify serves the app and runs that endpoint as a **Netlify Function**. The Netlify ZIP already contains the function, Netlify configuration, and static assets; it is different from the Render and Windows-local downloads.

- **No laptop server, router changes, API keys, database, or certificates** are needed.
- Netlify supplies the HTTPS URL required for iPhone camera and location permissions.
- The public website has **no password**. Anyone with the URL can open it.
- Camera video and GPS coordinates stay in each visitor's browser; Skyward does not send them to its server. The hosting platform may receive ordinary request logs such as visitors' IP addresses.

## Before you begin

You need a GitHub account and a Netlify account for the recommended setup. The current easiest Netlify Free Git workflow is to use a **public GitHub repository**. That makes the **source code** public too, not just the website. This project contains no passwords, API keys, private certificates, or generated user data, and it is MIT-licensed.

If you do not want the source repository public, skip the GitHub route and use the manual Netlify CLI option below. Do not paste account passwords or login tokens into chat.

## Part 1 — upload the project to GitHub

1. Download **`Skyward-Netlify-Free.zip`** and save it on your Windows laptop.
2. In File Explorer, right-click the ZIP and choose **Extract All**. Open the extracted `skyward-netlify` folder.
3. Create a repository on [GitHub](https://github.com): choose **New repository**, name it `skyward-netlify`, set it to **Public** for the free Git-based workflow, and leave **Add a README file** unchecked.
4. In the empty repository, choose **uploading an existing file** or **Add file → Upload files**.
5. Open the extracted `skyward-netlify` folder, select **everything inside it**, and drag those contents into GitHub's upload area. Upload the *contents*, not the ZIP and not an enclosing folder. When uploaded correctly, `netlify.toml`, `package.json`, `public/`, and `netlify/` are visible at the repository's top level.
6. Scroll down and choose **Commit changes**.

This is a small upload (fewer than 100 files). Do not add the Windows-private-hosting folder, generated certificate profiles, or any passwords.

## Part 2 — deploy it on Netlify

1. Sign in or create your account at [Netlify](https://www.netlify.com/).
2. Choose **Add new project → Import an existing project → GitHub**. Authorize Netlify to access your GitHub repository, then select **`skyward-netlify`**.
3. Check that the project root is the repository root and review the detected settings. They are already in `netlify.toml`:
   - Build command: `npm run build`
   - Publish directory: `public`
   - Functions directory: `netlify/functions`
   - Node.js: `24.21.0`
4. No environment variables or API keys are required. Choose the **Free** plan if a plan is requested, then deploy.
5. Wait for the deploy to finish. Open the generated `https://…netlify.app` address from the Netlify project page. That is your public site link; it is not a private or password-protected link.

If Netlify asks for a site name, choose any available name. The finished URL will use that name. For later code updates, commit the changes to GitHub; Netlify will build and publish the updated site.

## Part 3 — open the site on your iPhone

1. Open the Netlify HTTPS address directly in **Safari**, in a regular tab. Avoid opening it inside another app's built-in browser.
2. Check the location label in Skyward. **PREVIEW** means it is using the sample Colombo coordinates, not your live position.
3. Tap **Use my location** and allow location access. If GPS is unavailable or denied, open Settings in Skyward and enter coordinates manually.
4. Tap **Open camera** and allow camera access. Allow motion/orientation if iOS asks. Point the rear camera toward the sky and calibrate the compass/field of view in the app's Settings if alignment needs correction.
5. Tap **Stop camera** when finished. The video is only displayed locally; it is not uploaded or recorded by Skyward.

Skyward calculates where catalogued satellites should appear from orbital elements and your observer position. It does **not** detect satellites in the camera image, zoom in on them, or guarantee that an object is visible to the naked eye. Weather, brightness, obstructions, and sensor accuracy can affect what you see. Never point optics at the Sun.

## Free-plan limits and credits

Netlify's current Free plan is $0 and includes **300 credits per month with a hard limit and no automatic recharge**. Functions are included, but function execution, traffic, bandwidth, and production deployments use credits. This is a hobby-scale allowance, not unlimited public hosting. Check **Usage & billing** in Netlify if the site is used by many people. This Skyward build caches the shared public orbital catalog at Netlify's durable CDN for up to two hours to reduce function runs and upstream traffic.

Current official details: [Netlify Functions](https://docs.netlify.com/build/functions/get-started/) and [credit-based plans and limits](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/credit-based-pricing-plans/).

## Manual deployment option (keep GitHub source private)

Netlify supports manual deploys through its CLI, so a GitHub repository is optional. This route requires Node.js and the Netlify CLI on Windows:

1. Install Node.js 24 or newer, then open PowerShell in the extracted `skyward-netlify` folder (the one containing `netlify.toml`).
2. Run `npm install -g netlify-cli` and wait for it to finish.
3. Run `netlify login` and complete sign-in in the browser that opens.
4. Run `netlify deploy --prod --dir=public --functions=netlify/functions`.
5. If prompted, create a new Netlify site, select the free plan, and follow the CLI prompts. Keep the folder containing `netlify.toml` as the current directory.

Netlify CLI instructions: [manual deploys](https://docs.netlify.com/deploy/create-deploys/) and [CLI setup](https://docs.netlify.com/api-and-cli-guides/cli-guides/get-started-with-cli/). Do not share the CLI's access token.

## Troubleshooting

### Netlify page loads, but the satellite catalog does not

- Check the Netlify deploy's **Functions** and **Logs** panels for `catalog` errors.
- Confirm `netlify.toml` and `netlify/functions/catalog.mjs` are at the repository root/folder, not nested one level down.
- Try reloading after a short wait. The catalog comes from public orbital-data providers; if all TLE feeds are temporarily unavailable, the endpoint returns a retryable error rather than inventing positions.
- Netlify's shared catalog cache lasts up to two hours, so pressing refresh may not force an upstream refresh immediately.

### Camera or location permissions do not appear

- Use the `https://…netlify.app` URL in Safari, not an HTTP link or another app's embedded browser.
- Tap the camera and location controls inside Skyward; permissions are only requested after you tap.
- If you previously denied a permission, review Safari's website settings for that site, allow the relevant permission, then reload.
- You can still test the app without GPS by entering coordinates manually. The camera view needs the HTTPS site and the iPhone's camera permission.

### Markers are not aligned with the sky

- Verify that the app is using your actual GPS/manual location rather than the Colombo preview.
- Let the phone orientation sensor settle; use Compass correction and camera field-of-view settings. The model is an estimate, not image-based star tracking.

### Build fails

- Verify the repository root contains `netlify.toml`, `package.json`, `public/`, and `netlify/functions/`.
- In Netlify's deploy settings, keep the publish directory `public` and functions directory `netlify/functions`.
- The included build command only runs syntax checks. No API keys or additional packages are needed.

### Credits run out

Open Netlify **Usage & billing** to confirm. On the Free plan there is a hard monthly credit limit and no automatic recharge. If you reach it, wait for the next monthly reset or choose another host/plan; do not enter payment details unless you intend to upgrade.

## Privacy, visibility, and removing the site

- This is an **open site with no login**. Anyone who has or discovers its URL can use it. Do not deploy this version if you require device-only or password-protected access.
- On the recommended Netlify Free Git route, the GitHub repository is public too. The deployed website is public regardless of GitHub visibility.
- Camera pixels, GPS, and manual coordinates are processed in the browser and are not sent to the catalog function. The function only fetches the same public orbital catalog for all visitors.
- To take the site offline, delete the Netlify project in its project settings. This does not automatically delete the GitHub repository; delete that separately if you also want the source removed.

## What is in the Netlify package

- `public/` — Skyward's mobile website and local assets.
- `netlify/functions/catalog.mjs` — public satellite catalog endpoint at `/api/catalog`.
- `netlify/functions/health.mjs` — health endpoint at `/api/health`.
- `netlify.toml` — build, Node, publish, and Functions settings.
- `LICENSE` — MIT license.

The deployment ZIP omits development tests, build outputs, screenshots, saved orbital caches, private Windows-launcher files, and all credentials. Only the files needed for the Netlify site are included.
