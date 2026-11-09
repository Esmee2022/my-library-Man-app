# Deploy the Library Workspace to Vercel

The web server is Express, the production authentication and library database stay on Supabase, and encrypted backup copies can continue to use S3. Vercel hosts the web pages and API. Do not use the local SQLite database for production on Vercel because function filesystems are not durable.

## Import the repository

1. Sign in to Vercel and choose **Add New → Project**.
2. Import `Esmee2022/my-library-Man-app` from GitHub and select `main`.
3. Keep the repository root as the Root Directory and the **Express** Framework Preset. The configured build command prepares the frontend under `public/`; the root `server.js` exports the Express app. This is a single Express project, not a Vercel Services project.
4. Add the environment variables below under **Project Settings → Environment Variables**. Add them to Production and Preview where appropriate, then deploy.
5. After the first deployment, copy the assigned `*.vercel.app` URL. Set `FRONTEND_ORIGIN` to that URL and include the URL in `WEB_ORIGINS` (comma-separated if there are more trusted web origins). Redeploy after changing environment variables.
6. Open `https://<your-vercel-domain>/api/health`. Continue only when it reports `"status":"ok"` and the expected Supabase stores are ready. Then confirm login, 2FA, catalogue, borrowing, admin workspace, and database backup from the Vercel URL.

## Production environment variables

Copy values from the existing protected Render environment. Do not paste secret values into GitHub or source files.

| Name | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `AUTH_STORE` | `supabase` |
| `PASSWORD_PEPPER` | The existing password pepper used for current accounts; keep it unchanged |
| `SESSION_SECRET` | The existing session secret, or a new random secret if existing sessions may be invalidated |
| `ENCRYPTION_KEY` | The existing 64-character hex key used to decrypt current TOTP secrets |
| `SUPABASE_URL` | Existing Supabase project URL |
| `SUPABASE_SECRET_KEY` | Existing Supabase server-side secret/service key |
| `FRONTEND_ORIGIN` | The Vercel production URL, e.g. `https://your-project.vercel.app` |
| `WEB_ORIGINS` | The same production URL; add any other trusted web origins comma-separated |
| `AWS_REGION` | Existing S3 bucket region, if database backup to S3 is enabled |
| `AWS_S3_BUCKET` | Existing private backup bucket name, if enabled |
| `AWS_ACCESS_KEY_ID` | Existing restricted S3 backup access key ID, if enabled |
| `AWS_SECRET_ACCESS_KEY` | Matching S3 secret access key, if enabled |

Do not run the seed command during migration. Existing users and library records remain in Supabase. Keep Render online until the Vercel health check and the core workflows above pass.

## Point the Android app at Vercel

After Vercel is healthy, change the Expo `EXPO_PUBLIC_API_URL` environment variable to `https://<your-vercel-domain>/api`, for the same EAS environment/channel used by your installed Android app. Publish a new EAS update/build so the installed app starts using the Vercel API. Keep the existing Render value until the Vercel API is confirmed healthy.

## Rollback

Render remains the rollback target during the transition. If a Vercel check fails, leave the mobile API URL unchanged and continue using Render while correcting the Vercel environment or build configuration.
