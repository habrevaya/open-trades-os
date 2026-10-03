# OpenTradesOS Field

The technician app: an Expo (React Native) app that runs a technician's day
against your own OpenTradesOS server, and keeps working with no signal.

What it does, and why it is built the way it is, is in
`docs/modules/m11-mobile-field-app.md`. This file is how to run it and how to
build it.

## What has and has not been checked

Typechecked under the repository's strict settings, linted with the shared
config, its logic unit tested (here and, for the queue, the sync and the
uploads, in `packages/field-client`), bundled for Android and iOS with
`expo export`, and passed by `expo-doctor`. It has **not** been run on a
phone or a simulator, and no push notice has reached a real phone. Treat the
first install as the first test.

## Before you start

- A running OpenTradesOS server, reachable from the phone. Over the internet
  that means HTTPS; on your own network `http://` works, and the app warns
  that the password is not encrypted.
- A person with a **technician record** and a password, or a mobile number
  the office has set on `/settings/phones` (or a mail provider connected) so
  they can sign in with a one time code. An owner or office
  account without a technician record is refused at sign in, because it has no
  day to show.
- Node 22 and pnpm, from the repository root: `pnpm install`.

## Run it against your server

From the repository root:

```sh
pnpm --filter @opentradesos/mobile start
```

That starts Expo's development server. Open the app on a phone with a
development build (below), or press `a` for an Android emulator or `i` for an
iOS simulator on a Mac.

In the app, enter your server's address (`ops.yourcompany.com`, or
`http://192.168.1.20:3000` for a server on your desk), then the technician's
email and password, or ask for a one time code by text or email. The app
calls `POST /api/v1/field/sign-in` (or `/sign-in/code` and `/sign-in/verify`)
and `POST /api/v1/field/devices` on that server, and nothing outside it except
Expo's own service for a push token.

Running the web server locally for this: `pnpm --filter @opentradesos/web dev`
listens on port 3000. A phone on the same Wi-Fi reaches it at your computer's
address, not `localhost`.

### Expo Go will not do

The app uses native modules (SQLite, the secure store, the camera, background
tasks) at versions Expo Go may not carry, so use a development build:

```sh
cd apps/mobile
npx expo run:android      # needs the Android SDK
npx expo run:ios          # needs a Mac with Xcode
```

or build one in the cloud with EAS (below, the `development` profile).

## Notices about the day

When the office puts a visit on somebody's day, takes it off, moves it or
cancels it, the worker pushes a notice to their phone through Expo's push
service, and a tap opens the visit. For that the app needs a push token, and
Expo issues one only to a build that belongs to an Expo project: run
`eas init` (below), which writes the project id into `app.json`, before
building. A build without one works in every other way and says on the day
screen that it cannot get notices.

The app asks for permission on first launch. On Android it makes two
channels, "Changes to your day" and "Changes to your day, at night"; the
second has no sound and is what the server uses inside the company's quiet
hours, so a person can silence it in the phone's settings and still be woken
for a job that night. A company that requires an access token for its Expo
project sets `EXPO_ACCESS_TOKEN` for the worker.

## Build it with EAS

[EAS Build](https://docs.expo.dev/build/introduction/) builds the native apps
in Expo's cloud, so nobody needs Xcode or Android Studio. You need an Expo
account, and for iOS an Apple Developer account.

```sh
npm install -g eas-cli
cd apps/mobile
eas login
eas init                  # links the project and writes its id into app.json
eas build --profile preview --platform android    # an APK to install directly
eas build --profile preview --platform ios        # for registered test devices
eas build --profile production --platform all     # for the stores
eas submit --profile production --platform ios    # optional: to App Store Connect
```

The profiles are in `eas.json`: `development` and `preview` are internal
distribution (an installable APK on Android), `production` is for the stores
and numbers its own builds.

Before a store build, change `ios.bundleIdentifier` and `android.package` in
`app.json` to identifiers your company owns (`com.yourcompany.field`), and the
`name` to what technicians should see on the home screen. Nothing else in the
app names a server or a company: each install is pointed at a server by the
person signing in.

## How it fits together

| Where | What |
|---|---|
| `src/shell/App.tsx` | Five screens on a stack, and the hardware back button |
| `src/state/FieldProvider.tsx` | Every write, every send, sign in and out |
| `src/screens/` | Sign in (password or code), the day, a visit and its work (checklist, readings, parts, payment), the signature pad, what is waiting to send |
| `src/platform/` | SQLite, the Keychain, the camera's files, the background task, notices |
| `src/lib/` | The logic the screens use, tested without a phone |
| `packages/field-client` | The queue, the sync, uploads and the day, shared with the web page |

Storage: the queue is in SQLite, one database per person per server, because a
write that has returned is on disk. The device token is in the Keychain or
Keystore, readable after the first unlock so the background task can send
while the phone is in a pocket.

Background: the app registers one background task that runs the same sync as
the screen. Android runs it no more often than every fifteen minutes; iOS runs
it when the phone decides, which can be hours. The app sends straight away on
every tap and whenever the signal returns, so the background task is a
backstop.

## Tests

```sh
pnpm --filter @opentradesos/mobile test
pnpm --filter @opentradesos/mobile typecheck
pnpm --filter @opentradesos/mobile lint
pnpm --filter @opentradesos/field-client test
```

And a bundle, which is the nearest thing to a build that runs without a
phone:

```sh
cd apps/mobile && npx expo export --platform android --platform ios --output-dir dist
```

## Signing out and taking a phone away

Signing out on the phone ends its token on the server and stops its notices.
Work not yet sent stays on the phone and goes when that person signs in again.

The office takes a lost phone away on `/settings/phones` (needs `user:write`),
which ends its token on every route at once and stops its notices; the same is
`POST /api/v1/field/devices/{id}/revoke`. Deactivating a person ends every
sign in they hold, phones included.
