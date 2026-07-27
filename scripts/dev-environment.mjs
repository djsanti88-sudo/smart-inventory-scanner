export const EMULATOR_PROJECT_ID = "demo-smart-inventory";

const EMULATOR_ENV_KEYS = [
  "FIRESTORE_EMULATOR_HOST",
  "FIREBASE_AUTH_EMULATOR_HOST",
  "NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_URL",
  "NEXT_PUBLIC_FIREBASE_FIRESTORE_EMULATOR_HOST",
  "NEXT_PUBLIC_FIREBASE_FIRESTORE_EMULATOR_PORT",
];

function clearEmulatorRouting(env) {
  for (const key of EMULATOR_ENV_KEYS) delete env[key];
}

export function buildDevEnvironment(mode, baseEnvironment = process.env) {
  const env = { ...baseEnvironment };

  if (mode === "mock") {
    clearEmulatorRouting(env);
    env.NEXT_PUBLIC_FIREBASE_BACKEND = "0";
    env.NEXT_PUBLIC_FIREBASE_USE_EMULATOR = "0";
    env.NEXT_PUBLIC_E2E_AUTH_BYPASS = "1";
    delete env.NEXT_PUBLIC_FIREBASE_ALLOW_PROD;
    return env;
  }

  if (mode === "emulator") {
    env.NEXT_PUBLIC_FIREBASE_BACKEND = "1";
    env.NEXT_PUBLIC_FIREBASE_USE_EMULATOR = "1";
    env.NEXT_PUBLIC_FIREBASE_PROJECT_ID = EMULATOR_PROJECT_ID;
    env.NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_URL = "http://127.0.0.1:9099";
    env.NEXT_PUBLIC_FIREBASE_FIRESTORE_EMULATOR_HOST = "127.0.0.1";
    env.NEXT_PUBLIC_FIREBASE_FIRESTORE_EMULATOR_PORT = "8080";
    env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";
    env.FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:9099";
    env.FIREBASE_PROJECT_ID = EMULATOR_PROJECT_ID;
    env.GCLOUD_PROJECT = EMULATOR_PROJECT_ID;
    env.GOOGLE_CLOUD_PROJECT = EMULATOR_PROJECT_ID;
    delete env.NEXT_PUBLIC_FIREBASE_ALLOW_PROD;
    delete env.NEXT_PUBLIC_E2E_AUTH_BYPASS;
    return env;
  }

  clearEmulatorRouting(env);
  env.NEXT_PUBLIC_FIREBASE_BACKEND = "1";
  env.NEXT_PUBLIC_FIREBASE_USE_EMULATOR = "0";
  env.NEXT_PUBLIC_FIREBASE_ALLOW_PROD = "1";
  delete env.NEXT_PUBLIC_E2E_AUTH_BYPASS;
  return env;
}
