# Host the API on AWS and keep Supabase

The Expo app is the mobile client. AWS App Runner hosts the Node.js API and web workspace, while Supabase remains the database and cloud backup service. App Runner provides the public HTTPS address used by Expo.

## Before creating the AWS service

1. Put this project in a private GitHub repository. App Runner's source deployment connects to a GitHub repository and builds the root `apprunner.yaml` configuration.
2. In AWS, create the App Runner service from that repository and select the branch you want to deploy. The service configuration uses Node.js 22, runs `node server/server.js`, and listens on the port App Runner provides.
3. Store these values in AWS Secrets Manager, then reference them as App Runner runtime secrets. Never place secret values in `apprunner.yaml`, GitHub, Expo, or chat:
   - `PASSWORD_PEPPER`: use the exact existing value used to hash the current Supabase accounts. Changing it will prevent those accounts from signing in.
   - `ENCRYPTION_KEY`: use the exact existing 64-character hexadecimal key used to encrypt the users' 2FA seeds. Changing it will prevent their existing authenticator setup from working.
   - `SESSION_SECRET`: use a strong random value of at least 32 characters. Changing it invalidates existing browser sessions.
   - `SUPABASE_SECRET_KEY`: use a server-side Supabase secret key with the required database permissions. Rotate the key previously shared in chat, then store the replacement here.
4. Add `SUPABASE_URL` as a non-secret App Runner environment variable using the existing project URL. Keep `AUTH_STORE=supabase` and `NODE_ENV=production` as configured in `apprunner.yaml`.
5. Set the App Runner health check to HTTP at `/api/health`. A healthy response confirms the server can reach Supabase and the required schema is available.

App Runner terminates public HTTPS and forwards requests to the app over HTTP. The app's secure session cookies remain HTTPS-only for browser sign-in. The Expo mobile client uses bearer tokens after 2FA and does not need a browser cookie.

## Point Expo at AWS

After App Runner creates the service, copy its HTTPS service URL into `mobile/.env`:

```dotenv
EXPO_PUBLIC_API_URL=https://your-app-runner-service-url/api
```

This URL is public configuration. Do not put any Supabase key, password pepper, encryption key, or session secret in the Expo app. Configure the same public URL as an EAS environment variable before production builds, then create your Android or iOS build with EAS.

## Finish deployment

After the service deploys, open `https://<app-runner-service-url>/api/health`. It should return `status: "ok"` and `libraryDatabase: "ready"`. Sign in with an existing library account, complete 2FA, and confirm catalogue access before creating a mobile build.

App Runner and Secrets Manager are AWS resources that can incur ongoing charges. Review the current AWS pricing for your selected region and service settings before creating them. A custom domain is optional; if you add one, configure it in App Runner and use that HTTPS address for Expo.
