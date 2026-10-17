# Expo mobile application

The app is a native React Native client using Expo Router. It implements password + TOTP/recovery-code login, displays enrollment QR/recovery codes, stores only the short-lived session token and CSRF token in Expo SecureStore, searches the shared catalogue, shows personal loan history, provides librarian return actions and manager reports, and reads the account's server-resolved role.

## Run

1. Install Node.js 20.19+ (Node 22.13+ for Expo SDK 57+; this project targets SDK 56).
2. Install dependencies: `npm install`.
3. Copy `.env.example` to `.env` and set `EXPO_PUBLIC_API_URL` to the deployed API URL, or a reachable development API URL. Physical devices cannot use `localhost`; use a trusted HTTPS hostname in production.
4. Start Metro with `npm start`, then select Android or iOS.

The API must support bearer session tokens on `Authorization`; the token is returned only when the 2FA request includes `mobile: true`. Never add Supabase service keys, database URLs, pepper, encryption key, or passwords to Expo configuration.

For local Android emulator development, the host may be reachable at `http://10.0.2.2:3000/api` when the API is explicitly started in HTTP development mode. HTTP is rejected by the app outside `__DEV__`. For an iOS simulator use the host machine's reachable address. Production requires HTTPS.

## Build

Install EAS CLI, configure the Expo project with your own Expo account, then use `eas build --platform android --profile preview` or `eas build --platform ios --profile preview`. Store submission requires the developer's signing accounts and current store review.
